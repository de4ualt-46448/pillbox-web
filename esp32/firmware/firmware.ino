/**
 * Z Care Smart Pillbox — scheduled hand-triggered MQTT firmware
 *
 * Active hardware profile:
 *   Servo trapdoor ........ GPIO 23
 *   HC-SR04 TRIG .......... GPIO 18
 *   HC-SR04 ECHO .......... GPIO 19 (use a voltage divider for 5 V echo)
 *   Active buzzer .......... GPIO 4
 *
 * Core workflow:
 *   1. The ultrasonic hand sensor is OFF while the pillbox is idle.
 *   2. The ESP32 receives the medication schedule from the website through MQTT.
 *   3. At a scheduled medication time, the sensor and reminder become active.
 *   4. A stable hand reading at 5 cm or less starts dispensing.
 *   5. The configured quantity is dispensed as repeated servo cycles.
 *   6. Immediately after the dosage sequence is complete, sensor sampling stops,
 *      one dose event is published, and the device returns to a non-detecting state.
 *
 * This firmware assumes one servo release cycle corresponds to one configured
 * dose unit. A true multi-slot carousel or pill-drop sensor needs a different
 * hardware profile and must not be inferred from this sketch.
 *
 * Required libraries:
 *   WiFi, WebServer, ESP32Servo, PubSubClient, ArduinoJson, Preferences
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

// -----------------------------------------------------------------------------
// User configuration — edit before flashing
// -----------------------------------------------------------------------------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// Use the same timezone as the medication schedule in the website.
// Examples: UTC0, EET-2EEST,M3.5.0/3,M10.5.0/4, or your local POSIX TZ string.
const char* TIMEZONE_INFO = "UTC0";

// Functional testing only. Use an authenticated TLS broker for a real device.
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_ID = "pillbox-01";

// -----------------------------------------------------------------------------
// Hardware pins and behavior
// -----------------------------------------------------------------------------
#define SERVO_PIN 23
#define ULTRASONIC_TRIG 18
#define ULTRASONIC_ECHO 19
#define BUZZER_PIN 4

#define HAND_DETECT_CM 5.0f
#define HAND_DEBOUNCE_READINGS 3
#define SENSOR_SAMPLE_INTERVAL_MS 120UL
#define ACTIVE_WINDOW_MS (5UL * 60UL * 1000UL)
#define DISPENSE_OPEN_MS 400UL
#define DISPENSE_HOLD_MS 1800UL
#define DISPENSE_CLOSE_MS 600UL
#define COOLDOWN_MS 3000UL
#define ALARM_TICK_ON_MS 300UL
#define ALARM_TICK_OFF_MS 700UL
#define CONFIRM_BEEP_MS 250UL
#define STATUS_INTERVAL_MS 10000UL
#define TELEMETRY_INTERVAL_MS 2000UL
#define MQTT_RETRY_MS 5000UL
#define WIFI_RETRY_MS 15000UL
#define TIME_SYNC_RETRY_MS 60000UL
#define MAX_SCHEDULE_MEDS 16
#define MAX_TIMES_PER_MED 8
#define MAX_RECENT_OCCURRENCES 12

#define SERVO_CLOSED 0
#define SERVO_OPEN 90

WebServer httpServer(80);
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
Preferences preferences;
Servo pillServo;

String mqttTopicCmd;
String mqttTopicRequest;
String mqttTopicStatus;
String mqttTopicTelemetry;
String mqttTopicDose;
String mqttTopicEvent;

struct ScheduledMedication {
  String medicationId;
  String name;
  String dosage;
  String timesOfDay[MAX_TIMES_PER_MED];
  uint8_t timeCount = 0;
  uint16_t quantityPerDose = 1;
  uint8_t slot = 0;
};

ScheduledMedication scheduleMeds[MAX_SCHEDULE_MEDS];
uint8_t scheduleCount = 0;
String scheduleVersion = "none";
String recentOccurrences[MAX_RECENT_OCCURRENCES];
uint8_t recentOccurrenceCount = 0;

// -----------------------------------------------------------------------------
// Device state
// -----------------------------------------------------------------------------
enum PillboxState {
  STATE_IDLE,
  STATE_ACTIVE_WINDOW,
  STATE_DISPENSE_OPEN,
  STATE_DISPENSE_HOLD,
  STATE_DISPENSE_CLOSE,
  STATE_COOLDOWN,
  STATE_ERROR
};

PillboxState currentState = STATE_IDLE;

bool sensorEnabled = false;
bool timeSynchronized = false;
bool alarmEnabled = false;
bool handDetected = false;
float currentDistanceCm = 999.0f;
int currentServoAngle = SERVO_CLOSED;
uint8_t stableHandReadings = 0;

String activeMedicationId;
String activeMedicationName;
String activeDosage;
String activeOccurrenceId;
String activeCommandId;
uint16_t activeQuantity = 1;
uint16_t quantityDispensed = 0;

unsigned long activeWindowStartedAt = 0;
unsigned long dispensePhaseStartedAt = 0;
unsigned long cooldownStartedAt = 0;
unsigned long lastSensorReadAt = 0;
unsigned long lastStatusPublishedAt = 0;
unsigned long lastTelemetryPublishedAt = 0;
unsigned long lastMqttRetryAt = 0;
unsigned long lastWifiRetryAt = 0;
unsigned long lastTimeSyncAttemptAt = 0;

uint32_t commandSequence = 0;

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------
const char* stateName() {
  switch (currentState) {
    case STATE_IDLE: return "idle";
    case STATE_ACTIVE_WINDOW: return "active_window";
    case STATE_DISPENSE_OPEN: return "dispense_open";
    case STATE_DISPENSE_HOLD: return "dispense_hold";
    case STATE_DISPENSE_CLOSE: return "dispense_close";
    case STATE_COOLDOWN: return "cooldown";
    case STATE_ERROR: return "error";
    default: return "unknown";
  }
}

void buildMqttTopics() {
  String base = String("pillbox/") + DEVICE_ID;
  mqttTopicCmd = base + "/cmd";
  mqttTopicRequest = base + "/request";
  mqttTopicStatus = base + "/status";
  mqttTopicTelemetry = base + "/telemetry";
  mqttTopicDose = base + "/dose";
  mqttTopicEvent = base + "/event";
}

String makeCommandId() {
  commandSequence++;
  return String(DEVICE_ID) + "-" + String(millis()) + "-" + String(commandSequence);
}

bool mqttReady() {
  return WiFi.status() == WL_CONNECTED && mqttClient.connected();
}

String twoDigits(int value) {
  return value < 10 ? String("0") + String(value) : String(value);
}

bool getLocalTimeNow(struct tm& info) {
  time_t now = time(nullptr);
  if (now < 1700000000) return false;
  localtime_r(&now, &info);
  return true;
}

String currentMinuteKey() {
  struct tm info;
  if (!getLocalTimeNow(info)) return "";
  return String(info.tm_year + 1900) + twoDigits(info.tm_mon + 1) + twoDigits(info.tm_mday) +
         twoDigits(info.tm_hour) + twoDigits(info.tm_min);
}

String occurrenceIdFor(const String& medicationId, const String& timeOfDay) {
  struct tm info;
  if (!getLocalTimeNow(info)) return medicationId + "|unsynced|" + timeOfDay;
  return String(info.tm_year + 1900) + "-" + twoDigits(info.tm_mon + 1) + "-" +
         twoDigits(info.tm_mday) + "|" + timeOfDay + "|" + medicationId;
}

String activeOccurrenceKey() {
  return activeOccurrenceId;
}

bool containsRecentOccurrence(const String& occurrenceId) {
  for (uint8_t i = 0; i < recentOccurrenceCount; i++) {
    if (recentOccurrences[i] == occurrenceId) return true;
  }
  return false;
}

void persistRecentOccurrences() {
  StaticJsonDocument<1024> doc;
  JsonArray array = doc.to<JsonArray>();
  for (uint8_t i = 0; i < recentOccurrenceCount; i++) array.add(recentOccurrences[i]);
  String serialized;
  serializeJson(doc, serialized);
  preferences.putString("completed", serialized);
}

void rememberOccurrence(const String& occurrenceId) {
  if (occurrenceId.length() == 0 || containsRecentOccurrence(occurrenceId)) return;
  if (recentOccurrenceCount < MAX_RECENT_OCCURRENCES) {
    recentOccurrences[recentOccurrenceCount++] = occurrenceId;
  } else {
    for (uint8_t i = 1; i < MAX_RECENT_OCCURRENCES; i++) {
      recentOccurrences[i - 1] = recentOccurrences[i];
    }
    recentOccurrences[MAX_RECENT_OCCURRENCES - 1] = occurrenceId;
  }
  persistRecentOccurrences();
}

void loadRecentOccurrences() {
  recentOccurrenceCount = 0;
  String raw = preferences.getString("completed", "[]");
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, raw)) return;
  if (!doc.is<JsonArray>()) return;
  for (JsonVariant value : doc.as<JsonArray>()) {
    if (recentOccurrenceCount >= MAX_RECENT_OCCURRENCES) break;
    recentOccurrences[recentOccurrenceCount++] = value.as<String>();
  }
}

void clearActiveDose() {
  activeMedicationId = "";
  activeMedicationName = "";
  activeDosage = "";
  activeOccurrenceId = "";
  activeCommandId = "";
  activeQuantity = 1;
  quantityDispensed = 0;
}

// -----------------------------------------------------------------------------
// Buzzer and sensor drivers
// -----------------------------------------------------------------------------
bool buzzerOn = false;
uint8_t buzzerMode = 0; // 0 off, 1 one-shot, 2 alarm
unsigned long buzzerStartedAt = 0;
unsigned long buzzerDurationMs = 0;
unsigned long buzzerLastToggleAt = 0;

void setBuzzer(bool enabled) {
  digitalWrite(BUZZER_PIN, enabled ? HIGH : LOW);
  buzzerOn = enabled;
}

void stopBuzzer() {
  buzzerMode = 0;
  setBuzzer(false);
}

void startBeep(unsigned long durationMs) {
  buzzerMode = 1;
  buzzerStartedAt = millis();
  buzzerDurationMs = durationMs;
  setBuzzer(true);
}

void startAlarm() {
  buzzerMode = 2;
  buzzerLastToggleAt = millis();
  setBuzzer(true);
  alarmEnabled = true;
}

void stopAlarm() {
  alarmEnabled = false;
  stopBuzzer();
}

void updateBuzzer() {
  unsigned long now = millis();
  if (buzzerMode == 0) return;
  if (buzzerMode == 1) {
    if (now - buzzerStartedAt >= buzzerDurationMs) stopBuzzer();
    return;
  }
  if (buzzerMode == 2) {
    unsigned long interval = buzzerOn ? ALARM_TICK_ON_MS : ALARM_TICK_OFF_MS;
    if (now - buzzerLastToggleAt >= interval) {
      buzzerLastToggleAt = now;
      setBuzzer(!buzzerOn);
    }
  }
}

float readDistanceCm() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 25000UL);
  if (duration == 0) return 999.0f;
  return (duration * 0.0343f) / 2.0f;
}

void disableHandSensor() {
  sensorEnabled = false;
  handDetected = false;
  stableHandReadings = 0;
  currentDistanceCm = 999.0f;
}

void enableHandSensor() {
  sensorEnabled = true;
  handDetected = false;
  stableHandReadings = 0;
  currentDistanceCm = 999.0f;
  lastSensorReadAt = 0;
}

// -----------------------------------------------------------------------------
// Schedule storage and parsing
// -----------------------------------------------------------------------------
void clearSchedule() {
  scheduleCount = 0;
  scheduleVersion = "none";
}

void appendTimeFromVariant(ScheduledMedication& med, JsonVariant value) {
  if (med.timeCount >= MAX_TIMES_PER_MED) return;
  String timeValue = value.as<String>();
  timeValue.trim();
  if (timeValue.length() >= 4) med.timesOfDay[med.timeCount++] = timeValue;
}

void parseMedicationTimes(ScheduledMedication& med, JsonVariant value) {
  med.timeCount = 0;
  if (value.is<JsonArray>()) {
    for (JsonVariant timeValue : value.as<JsonArray>()) appendTimeFromVariant(med, timeValue);
    return;
  }
  String raw = value.as<String>();
  raw.trim();
  int start = 0;
  while (start < (int)raw.length() && med.timeCount < MAX_TIMES_PER_MED) {
    int separator = raw.indexOf(',', start);
    if (separator < 0) separator = raw.length();
    String timeValue = raw.substring(start, separator);
    timeValue.trim();
    if (timeValue.length() >= 4) med.timesOfDay[med.timeCount++] = timeValue;
    start = separator + 1;
  }
}

void parseScheduleDocument(JsonDocument& doc, bool persist) {
  JsonArray meds = doc["meds"].as<JsonArray>();
  if (meds.isNull()) return;

  clearSchedule();
  scheduleVersion = doc["scheduleVersion"] | String(millis());

  for (JsonObject source : meds) {
    if (scheduleCount >= MAX_SCHEDULE_MEDS) break;
    String medicationId = source["medicationId"] | "";
    if (medicationId.length() == 0) continue;

    ScheduledMedication& med = scheduleMeds[scheduleCount++];
    med.medicationId = medicationId;
    med.name = source["name"] | "";
    med.dosage = source["dosage"] | "";
    med.quantityPerDose = source["quantityPerDose"] | 1;
    if (med.quantityPerDose == 0) med.quantityPerDose = 1;
    med.slot = source["slot"] | 0;
    parseMedicationTimes(med, source["timesOfDay"]);
  }

  if (persist) {
    String serialized;
    serializeJson(doc, serialized);
    if (serialized.length() <= 3800) preferences.putString("schedule", serialized);
    preferences.putString("version", scheduleVersion);
  }

  Serial.printf("[schedule] loaded %u medication entries, version=%s\n",
                (unsigned)scheduleCount, scheduleVersion.c_str());
}

void loadPersistedSchedule() {
  String raw = preferences.getString("schedule", "");
  if (raw.length() == 0) return;
  DynamicJsonDocument doc(4096);
  if (deserializeJson(doc, raw)) {
    Serial.println(F("[schedule] persisted schedule is invalid"));
    return;
  }
  parseScheduleDocument(doc, false);
}

ScheduledMedication* findMedication(const String& medicationId) {
  for (uint8_t i = 0; i < scheduleCount; i++) {
    if (scheduleMeds[i].medicationId == medicationId) return &scheduleMeds[i];
  }
  return nullptr;
}

// -----------------------------------------------------------------------------
// Event publishing
// -----------------------------------------------------------------------------
void publishStatus() {
  if (!mqttReady()) return;
  StaticJsonDocument<640> doc;
  doc["type"] = "status";
  doc["online"] = true;
  doc["deviceId"] = DEVICE_ID;
  doc["firmware"] = "zcare-scheduled-5cm-1";
  doc["state"] = stateName();
  doc["sensorActive"] = sensorEnabled;
  doc["scheduleVersion"] = scheduleVersion;
  doc["uptime"] = millis() / 1000UL;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  if (activeMedicationId.length()) {
    doc["activeMedicationId"] = activeMedicationId;
    doc["activeQuantity"] = activeQuantity;
    doc["quantityDispensed"] = quantityDispensed;
  }
  char buffer[640];
  serializeJson(doc, buffer, sizeof(buffer));
  mqttClient.publish(mqttTopicStatus.c_str(), buffer, true);
}

void publishTelemetry() {
  if (!mqttReady()) return;
  StaticJsonDocument<768> doc;
  doc["type"] = "telemetry";
  doc["timestamp"] = millis();
  doc["state"] = stateName();
  doc["sensorActive"] = sensorEnabled;
  doc["ultrasonic"]["distance"] = currentDistanceCm;
  doc["ultrasonic"]["handDetected"] = handDetected;
  doc["motors"]["stepper"]["moving"] = false;
  doc["motors"]["stepper"]["position"] = 0;
  doc["motors"]["servo"]["angle"] = currentServoAngle;
  doc["buzzer"]["active"] = buzzerOn;
  doc["medSlotCount"] = scheduleCount;
  if (activeMedicationId.length()) {
    doc["activeMedicationId"] = activeMedicationId;
    doc["activeQuantity"] = activeQuantity;
    doc["quantityDispensed"] = quantityDispensed;
  }
  char buffer[768];
  serializeJson(doc, buffer, sizeof(buffer));
  mqttClient.publish(mqttTopicTelemetry.c_str(), buffer, false);
}

void publishEvent(const char* type, const char* reason = nullptr) {
  if (!mqttReady()) return;
  StaticJsonDocument<768> doc;
  doc["type"] = type;
  doc["deviceId"] = DEVICE_ID;
  doc["state"] = stateName();
  if (activeMedicationId.length()) doc["medicationId"] = activeMedicationId;
  if (activeOccurrenceId.length()) doc["occurrenceId"] = activeOccurrenceId;
  if (activeCommandId.length()) doc["commandId"] = activeCommandId;
  doc["quantity"] = activeQuantity;
  doc["quantityDispensed"] = quantityDispensed;
  doc["sensorActive"] = sensorEnabled;
  if (reason) doc["reason"] = reason;
  char buffer[768];
  serializeJson(doc, buffer, sizeof(buffer));
  mqttClient.publish(mqttTopicEvent.c_str(), buffer, false);
}

void publishDose() {
  if (!mqttReady()) return;
  StaticJsonDocument<512> doc;
  doc["type"] = "dose";
  doc["deviceId"] = DEVICE_ID;
  doc["medicationId"] = activeMedicationId;
  doc["quantity"] = quantityDispensed;
  doc["occurrenceId"] = activeOccurrenceId;
  doc["commandId"] = activeCommandId;
  doc["confirmed"] = true;
  doc["sensorActive"] = false;
  char buffer[512];
  serializeJson(doc, buffer, sizeof(buffer));
  mqttClient.publish(mqttTopicDose.c_str(), buffer, false);
  Serial.printf("[mqtt] confirmed dose: %s x%u\n", activeMedicationId.c_str(), quantityDispensed);
}

void publishRequest(const char* type) {
  if (!mqttReady()) return;
  StaticJsonDocument<256> doc;
  doc["type"] = type;
  doc["deviceId"] = DEVICE_ID;
  doc["scheduleVersion"] = scheduleVersion;
  char buffer[256];
  serializeJson(doc, buffer, sizeof(buffer));
  mqttClient.publish(mqttTopicRequest.c_str(), buffer, false);
}

// -----------------------------------------------------------------------------
// Scheduled dose state machine
// -----------------------------------------------------------------------------
void finishActiveOccurrence(bool confirmed, const char* reason = nullptr) {
  // Disable first so the final sensor reading cannot retrigger the same dose.
  disableHandSensor();
  stopAlarm();
  if (activeOccurrenceId.length()) rememberOccurrence(activeOccurrenceId);

  if (confirmed) {
    publishDose();
    publishEvent("completed");
    startBeep(CONFIRM_BEEP_MS);
  } else {
    publishEvent("missed", reason ? reason : "active window expired");
  }

  currentState = STATE_COOLDOWN;
  cooldownStartedAt = millis();
}

void startDispense(const String& medicationId, const String& occurrenceId,
                  uint16_t quantity, const String& commandId, bool manual) {
  if (currentState != STATE_IDLE && currentState != STATE_ACTIVE_WINDOW) {
    publishEvent("rejected", "device busy");
    return;
  }

  ScheduledMedication* med = findMedication(medicationId);
  if (!manual && !med) {
    publishEvent("rejected", "medication not in synchronized schedule");
    return;
  }

  if (!manual && occurrenceId.length() && containsRecentOccurrence(occurrenceId)) {
    publishEvent("duplicate", "occurrence already completed");
    return;
  }

  activeMedicationId = medicationId;
  activeMedicationName = med ? med->name : medicationId;
  activeDosage = med ? med->dosage : "";
  activeOccurrenceId = occurrenceId;
  activeCommandId = commandId.length() ? commandId : makeCommandId();
  activeQuantity = quantity == 0 ? 1 : min(quantity, (uint16_t)12);
  quantityDispensed = 0;

  // Critical requirement: once hand detection triggers dispensing, sensor input
  // is disabled for the complete dosage sequence and cooldown.
  disableHandSensor();
  stopAlarm();
  currentState = STATE_DISPENSE_OPEN;
  dispensePhaseStartedAt = millis();
  pillServo.write(SERVO_OPEN);
  currentServoAngle = SERVO_OPEN;
  publishEvent("dispensing");
  Serial.printf("[dispense] start %s x%u%s\n", activeMedicationId.c_str(),
                activeQuantity, manual ? " (manual)" : " (scheduled)");
}

void startScheduledDose(ScheduledMedication& med, const String& occurrenceId,
                        const String& timeOfDay) {
  if (currentState != STATE_IDLE) return;
  if (containsRecentOccurrence(occurrenceId)) return;

  activeMedicationId = med.medicationId;
  activeMedicationName = med.name;
  activeDosage = med.dosage;
  activeOccurrenceId = occurrenceId;
  activeCommandId = makeCommandId();
  activeQuantity = med.quantityPerDose == 0 ? 1 : med.quantityPerDose;
  quantityDispensed = 0;
  currentState = STATE_ACTIVE_WINDOW;
  activeWindowStartedAt = millis();
  enableHandSensor();
  startAlarm();
  publishEvent("pill_time");
  Serial.printf("[schedule] active: %s at %s, quantity=%u, sensor <= %.1f cm\n",
                med.medicationId.c_str(), timeOfDay.c_str(), activeQuantity, HAND_DETECT_CM);
}

void checkSchedule() {
  if (!timeSynchronized || currentState != STATE_IDLE) return;
  struct tm info;
  if (!getLocalTimeNow(info)) return;

  String currentTime = twoDigits(info.tm_hour) + ":" + twoDigits(info.tm_min);
  for (uint8_t i = 0; i < scheduleCount; i++) {
    ScheduledMedication& med = scheduleMeds[i];
    for (uint8_t j = 0; j < med.timeCount; j++) {
      if (med.timesOfDay[j] != currentTime) continue;
      String occurrenceId = occurrenceIdFor(med.medicationId, med.timesOfDay[j]);
      startScheduledDose(med, occurrenceId, med.timesOfDay[j]);
      return;
    }
  }
}

void updateHandSensor() {
  if (!sensorEnabled || currentState != STATE_ACTIVE_WINDOW) return;
  unsigned long now = millis();
  if (now - lastSensorReadAt < SENSOR_SAMPLE_INTERVAL_MS) return;
  lastSensorReadAt = now;

  currentDistanceCm = readDistanceCm();
  bool withinThreshold = currentDistanceCm > 0.0f && currentDistanceCm <= HAND_DETECT_CM;
  if (withinThreshold) {
    if (stableHandReadings < HAND_DEBOUNCE_READINGS) stableHandReadings++;
  } else {
    stableHandReadings = 0;
    handDetected = false;
  }

  if (stableHandReadings >= HAND_DEBOUNCE_READINGS && !handDetected) {
    handDetected = true;
    String medicationId = activeMedicationId;
    String occurrenceId = activeOccurrenceId;
    uint16_t quantity = activeQuantity;
    String commandId = activeCommandId;
    // startDispense() disables the sensor before any actuator motion.
    startDispense(medicationId, occurrenceId, quantity, commandId, false);
  }
}

void updateDispensing() {
  unsigned long now = millis();
  if (currentState == STATE_ACTIVE_WINDOW) {
    if (now - activeWindowStartedAt >= ACTIVE_WINDOW_MS) {
      finishActiveOccurrence(false, "no hand detected within active window");
    }
    return;
  }

  if (currentState == STATE_DISPENSE_OPEN) {
    if (now - dispensePhaseStartedAt >= DISPENSE_OPEN_MS) {
      currentState = STATE_DISPENSE_HOLD;
      dispensePhaseStartedAt = now;
    }
    return;
  }

  if (currentState == STATE_DISPENSE_HOLD) {
    if (now - dispensePhaseStartedAt >= DISPENSE_HOLD_MS) {
      pillServo.write(SERVO_CLOSED);
      currentServoAngle = SERVO_CLOSED;
      currentState = STATE_DISPENSE_CLOSE;
      dispensePhaseStartedAt = now;
    }
    return;
  }

  if (currentState == STATE_DISPENSE_CLOSE) {
    if (now - dispensePhaseStartedAt >= DISPENSE_CLOSE_MS) {
      quantityDispensed++;
      if (quantityDispensed < activeQuantity) {
        pillServo.write(SERVO_OPEN);
        currentServoAngle = SERVO_OPEN;
        currentState = STATE_DISPENSE_OPEN;
        dispensePhaseStartedAt = now;
      } else {
        // Sensor remains disabled. The dose event is emitted only once.
        finishActiveOccurrence(true);
      }
    }
    return;
  }

  if (currentState == STATE_COOLDOWN && now - cooldownStartedAt >= COOLDOWN_MS) {
    clearActiveDose();
    currentState = STATE_IDLE;
  }
}

// -----------------------------------------------------------------------------
// MQTT handling
// -----------------------------------------------------------------------------
void applySchedule(JsonDocument& doc) {
  parseScheduleDocument(doc, true);
  publishEvent("schedule_synced");
  publishStatus();
}

void handleMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length >= 4096) {
    Serial.println(F("[mqtt] payload rejected: invalid size"));
    return;
  }

  DynamicJsonDocument doc(4096);
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.printf("[mqtt] JSON rejected: %s\n", error.c_str());
    return;
  }

  const char* action = doc["action"] | "";
  const char* type = doc["type"] | "";

  if (strcmp(action, "schedule") == 0) {
    applySchedule(doc);
    return;
  }

  if (strcmp(action, "dispense") == 0 || strcmp(type, "dispense") == 0) {
    String medicationId = doc["medicationId"] | "";
    if (medicationId.length() == 0) {
      publishEvent("rejected", "missing medicationId");
      return;
    }
    uint16_t quantity = doc["quantityPerDose"] | (doc["quantity"] | 1);
    String occurrenceId = doc["occurrenceId"] | "";
    String commandId = doc["commandId"] | makeCommandId();
    // Manual website/admin dispense remains available as an override. Scheduled
    // dispensing always follows the active 5 cm hand sensor path above.
    startDispense(medicationId, occurrenceId, quantity, commandId, true);
    return;
  }

  if (strcmp(action, "pill_time") == 0 || strcmp(action, "alarm") == 0 ||
      strcmp(type, "alarm") == 0) {
    String medicationId = doc["medicationId"] | "";
    ScheduledMedication* med = findMedication(medicationId);
    if (!med) {
      publishEvent("rejected", "alarm medication is not scheduled");
      return;
    }
    String occurrenceId = doc["occurrenceId"] | occurrenceIdFor(medicationId, "manual");
    startScheduledDose(*med, occurrenceId, "manual");
    return;
  }

  if (strcmp(action, "buzzer") == 0) {
    const char* pattern = doc["pattern"] | "off";
    uint16_t duration = doc["duration"] | 1000;
    if (strcmp(pattern, "beep") == 0) startBeep(duration);
    else if (strcmp(pattern, "alarm") == 0) startAlarm();
    else stopBuzzer();
    return;
  }

  if (strcmp(action, "servo") == 0 || strcmp(action, "open") == 0 || strcmp(action, "close") == 0) {
    int position = doc["position"] | (strcmp(action, "open") == 0 ? SERVO_OPEN : SERVO_CLOSED);
    position = constrain(position, 0, 180);
    pillServo.write(position);
    currentServoAngle = position;
    return;
  }
}

void connectMqtt() {
  if (!WiFi.isConnected() || mqttClient.connected()) return;
  String clientId = String("esp32-") + DEVICE_ID + "-" + String(random(10000));
  const char* lastWill = "{\"type\":\"status\",\"online\":false}";
  Serial.printf("[mqtt] connecting to %s:%u ...", MQTT_HOST, MQTT_PORT);
  bool connected = mqttClient.connect(clientId.c_str(), mqttTopicStatus.c_str(), 0, true, lastWill);
  if (!connected) {
    Serial.printf(" failed (rc=%d)\n", mqttClient.state());
    return;
  }

  Serial.println(F(" connected"));
  mqttClient.subscribe(mqttTopicCmd.c_str(), 1);
  publishStatus();
  publishRequest("hello");
  publishRequest("getSchedule");
}

// -----------------------------------------------------------------------------
// Time and Wi-Fi
// -----------------------------------------------------------------------------
void updateTimeSync() {
  if (WiFi.status() != WL_CONNECTED) return;
  unsigned long now = millis();
  if (timeSynchronized && now - lastTimeSyncAttemptAt < TIME_SYNC_RETRY_MS) return;
  if (!timeSynchronized || now - lastTimeSyncAttemptAt >= TIME_SYNC_RETRY_MS) {
    lastTimeSyncAttemptAt = now;
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    struct tm info;
    if (getLocalTimeNow(info)) {
      timeSynchronized = true;
      Serial.printf("[time] synchronized %04d-%02d-%02d %02d:%02d\n",
                    info.tm_year + 1900, info.tm_mon + 1, info.tm_mday,
                    info.tm_hour, info.tm_min);
    }
  }
}

void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 10000UL) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP=%s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("[wifi] connection pending; reconnect will continue in loop"));
  }
}

// -----------------------------------------------------------------------------
// Local diagnostic page
// -----------------------------------------------------------------------------
void handleRoot() {
  String html = "<html><head><meta name='viewport' content='width=device-width'>";
  html += "<style>body{font-family:sans-serif;background:#111;color:#fff;padding:20px}";
  html += ".card{max-width:520px;margin:auto;background:#222;padding:20px;border-radius:12px}";
  html += "button{padding:12px;margin:5px;border:0;border-radius:8px;background:#00e676}";
  html += "</style></head><body><div class='card'>";
  html += "<h2>Z Care Pillbox</h2>";
  html += "<p>MQTT: <b>" + String(mqttClient.connected() ? "connected" : "offline") + "</b></p>";
  html += "<p>State: <b>" + String(stateName()) + "</b></p>";
  html += "<p>Sensor: <b>" + String(sensorEnabled ? "active (<= 5 cm)" : "off") + "</b></p>";
  html += "<p>Schedule: <b>" + String(scheduleCount) + " medication(s)</b></p>";
  if (activeMedicationId.length()) {
    html += "<p>Active: " + activeMedicationId + " x" + String(activeQuantity) + "</p>";
    html += "<p>Distance: " + String(currentDistanceCm, 1) + " cm</p>";
  }
  html += "<form action='/test-arm' method='POST'><button>Test sensor window</button></form>";
  html += "</div></body></html>";
  httpServer.send(200, "text/html", html);
}

void handleTestArm() {
  if (scheduleCount == 0) {
    httpServer.send(400, "text/plain", "No synchronized schedule");
    return;
  }
  ScheduledMedication& med = scheduleMeds[0];
  startScheduledDose(med, occurrenceIdFor(med.medicationId, "manual-test"), "manual-test");
  httpServer.send(200, "text/plain", "Sensor active for test window");
}

// -----------------------------------------------------------------------------
// Arduino lifecycle
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=== Z Care Scheduled 5 cm Hand-Triggered Pillbox ==="));

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  setBuzzer(false);

  pillServo.attach(SERVO_PIN);
  pillServo.write(SERVO_CLOSED);
  currentServoAngle = SERVO_CLOSED;

  setenv("TZ", TIMEZONE_INFO, 1);
  tzset();

  preferences.begin("zcare", false);
  loadRecentOccurrences();
  loadPersistedSchedule();
  disableHandSensor();

  buildMqttTopics();
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(handleMqttMessage);
  mqttClient.setBufferSize(4096);

  setupWiFi();
  updateTimeSync();
  connectMqtt();

  httpServer.on("/", HTTP_GET, handleRoot);
  httpServer.on("/test-arm", HTTP_POST, handleTestArm);
  httpServer.begin();

  Serial.printf("[config] device=%s, timezone=%s, hand threshold=%.1f cm\n",
                DEVICE_ID, TIMEZONE_INFO, HAND_DETECT_CM);
  Serial.println(F("[system] ready; sensor OFF until scheduled pill time"));
}

void loop() {
  unsigned long now = millis();
  httpServer.handleClient();

  if (WiFi.status() != WL_CONNECTED && now - lastWifiRetryAt >= WIFI_RETRY_MS) {
    lastWifiRetryAt = now;
    WiFi.reconnect();
  }

  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected() &&
      now - lastMqttRetryAt >= MQTT_RETRY_MS) {
    lastMqttRetryAt = now;
    connectMqtt();
  }

  mqttClient.loop();
  updateTimeSync();
  updateBuzzer();
  checkSchedule();
  updateHandSensor();
  updateDispensing();

  if (mqttReady()) {
    if (now - lastStatusPublishedAt >= STATUS_INTERVAL_MS) {
      lastStatusPublishedAt = now;
      publishStatus();
    }
    if (now - lastTelemetryPublishedAt >= TELEMETRY_INTERVAL_MS) {
      lastTelemetryPublishedAt = now;
      publishTelemetry();
    }
  }
}
