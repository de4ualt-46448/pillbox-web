/**
 * Z Care ESP32 Smart Pillbox Firmware - Scheduled Dispense Edition
 *
 * ==========================================================================
 *  HARDWARE PIN ASSIGNMENTS  (edit here if your wiring differs)
 * ==========================================================================
 *    ESP32 DevKit V1
 *    Servo Motor (carousel/trapdoor) .... GPIO 23
 *    HC-SR04 Ultrasonic Sensor
 *       - TRIG .......................... GPIO 18
 *       - ECHO .......................... GPIO 19  (3.3V tolerant via divider)
 *    Buzzer ........................... GPIO 4   (ACTIVE buzzer, 1k resistor)
 *
 *  NOTE: Buzzer is an ACTIVE type (sounds when pin is HIGH).
 *        If you switch to a PASSIVE buzzer, replace the digitalWrite()-based
 *        buzzerOn/Off calls with tone(BUZZER_PIN, freq) / noTone(BUZZER_PIN).
 *
 * ==========================================================================
 *  REQUIRED LIBRARIES  (Arduino IDE / PlatformIO)
 * ==========================================================================
 *    WiFi            (ESP32 built-in)
 *    ESP32Servo      (Kevin Harrington's ESP32Servo)
 *    PubSubClient    (Nick O'Leary MQTT client)
 *    ArduinoJson     (>= 6.x)
 *
 * ==========================================================================
 *  FLOW
 * ==========================================================================
 *    1. Website sends MQTT command {"action":"pill_time"} (or "alarm").
 *    2. Buzzer rings (non-blocking alarm pattern) AND the ultrasonic sensor
 *       is ARMED.  When the pillbox is idle the sensor is fully INACTIVE so
 *       walking past the box never dispenses anything.
 *    3. While armed, if the sensor detects a hand (< HAND_DETECT_CM) the servo
 *       opens, the pill is taken, the servo closes and the alarm is silenced.
 *    4. After dispense OR after ALARM_TIMEOUT_MS with no hand, the system
 *       locks again until the next scheduled "pill_time".
 * ==========================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ============================================================
// Wi-Fi Configuration
// ============================================================
const char* WIFI_SSID = "WE_3D2278";
const char* WIFI_PASS = "233d2278";

// ============================================================
// MQTT Configuration
// ============================================================
const char* MQTT_HOST   = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER   = "";
const char* MQTT_PASS   = "";
const char* DEVICE_ID    = "pillbox-01";

String mqttTopicCmd;
String mqttTopicStatus;
String mqttTopicTelemetry;
String mqttTopicDose;

// ============================================================
// Hardware Pin Definitions
// ============================================================
#define SERVO_PIN       23
#define ULTRASONIC_TRIG 18
#define ULTRASONIC_ECHO 19
#define BUZZER_PIN      4

// ============================================================
// Tunable Constants  (edit to taste)
// ============================================================
#define ULTRASONIC_INTERVAL_MS 100   // min ms between sensor reads when armed
#define TRIG_PULSE_US         10
#define STATUS_INTERVAL_MS    10000
#define TELEM_INTERVAL_MS     2000
#define MQTT_RETRY_MS         5000
#define WIFI_RETRY_MS         30000

#define SERVO_CLOSED     0
#define SERVO_OPEN       90
#define HAND_DETECT_CM   10.0   // < this distance (cm) => hand present
#define DISPENSE_HOLD_MS 3000   // door stays open while user takes the pill

// ---- Alarm / timeout (per Issue 2) ---------------------------
#define ALARM_TIMEOUT_MS (5UL * 60UL * 1000UL)  // 5 minutes, configurable
#define ALARM_TICK_ON_US  300                    // active-buzzer alarm on time
#define ALARM_TICK_OFF_US 200                     // active-buzzer alarm off time
#define BEEP_CONFIRM_MS  300                     // success beep after dispense

// ---- Startup / WiFi connect ----------------------------------
#define BUZZER_STARTUP_MS 150

// ============================================================
// State Machine
// ============================================================
enum PillboxState {
  STATE_IDLE,           // waiting for next scheduled pill_time
  STATE_ARMED,          // alarm ringing + ultrasonic active, waiting for hand
  STATE_DISPENSE_OPEN,  // servo opening
  STATE_DISPENSE_HOLD,  // door held open
  STATE_DISPENSE_CLOSE, // servo closing
  STATE_COOLDOWN        // brief lockout after a dispense
};

PillboxState currentState = STATE_IDLE;

// ============================================================
// Global Objects
// ============================================================
WiFiClient    wifiClient;
PubSubClient  mqtt(wifiClient);
Servo         trapdoorServo;

// --- non-blocking timing --------------------------------------
unsigned long lastUltrasonicRead = 0;
unsigned long lastStatusSend    = 0;
unsigned long lastTelemetrySend = 0;
unsigned long lastMqttAttempt   = 0;
unsigned long lastWifiAttempt   = 0;

// --- alarm / arm state -----------------------------------------
unsigned long alarmStartTime   = 0;   // when STATE_ARMED began
unsigned long dispensePhaseStart = 0; // when current dispense phase began
unsigned long cooldownStartTime = 0;

// --- sensor & servo state --------------------------------------
float lastDistanceCm = 999.0;
bool  handDetected   = false;
int   currentServoAngle = SERVO_CLOSED;

#define COOLDOWN_MS 3000   // brief lockout after a dispense before returning to idle

// ============================================================
// Buzzer (ACTIVE) - non-blocking driver
//   Pattern 0 = off
//   Pattern 1 = single finite beep (BEEP_CONFIRM_MS style)
//   Pattern 2 = repeating alarm tick (toggled by ALARM_TICK_*_US)
//                runs until silenced explicitly (hand/timeout) - NOT time limited
// ============================================================
uint8_t       buzzerPattern     = 0;
bool          buzzerState       = false;
unsigned long buzzerBeepStart   = 0;
unsigned long buzzerBeepDur     = 0;
unsigned long buzzerLastToggle  = 0;

void buzzerPin(bool on) {
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
  buzzerState = on;
}

void buzzerStop() {
  if (buzzerPattern != 0 || buzzerState) {
    Serial.println(F("[buzzer] OFF"));
  }
  buzzerPin(false);
  buzzerPattern = 0;
}

// Single short beep - turns itself off after durationMs
void buzzerBeep(uint16_t durationMs) {
  buzzerPattern    = 1;
  buzzerBeepStart  = millis();
  buzzerBeepDur    = durationMs;
  buzzerPin(true);
  Serial.printf("[buzzer] beep start (%ums)\n", durationMs);
}

// Repeating alarm tick - runs until buzzerStop() is called.
// NOT capped by a duration; the STATE_ARMED timeout silences it.
void buzzerAlarmStart() {
  buzzerPattern    = 2;
  buzzerLastToggle = millis();
  buzzerPin(true);
  Serial.println(F("[buzzer] alarm START"));
}

void buzzerUpdate() {
  unsigned long now = millis();

  if (buzzerPattern == 0) return;

  if (buzzerPattern == 1) {
    // Finite beep - auto off
    if (now - buzzerBeepStart >= buzzerBeepDur) {
      buzzerPin(false);
      buzzerPattern = 0;
      Serial.println(F("[buzzer] beep finished"));
    }
    return;
  }

  if (buzzerPattern == 2) {
    // Repeating alarm tick: HIGH for ALARM_TICK_ON_US, LOW for ALARM_TICK_OFF_US
    // NOTE: microseconds used here because the ticks are short; we use delayMicroseconds
    // is avoided by tracking in millis() - but the ticks could be < 1ms. For an active
    // buzzer the audible result is a fast warble, which we model with millis() granularity
    // by reading ALARM_TICK_*_US as ms via a small helper.
    unsigned long onMs  = (ALARM_TICK_ON_US  + 999) / 1000;  // round up so it's never 0
    unsigned long offMs = (ALARM_TICK_OFF_US + 999) / 1000;
    if (onMs  == 0) onMs  = 1;
    if (offMs == 0) offMs = 1;

    unsigned long since = now - buzzerLastToggle;
    if (buzzerState && since >= onMs) {
      buzzerPin(false);
      buzzerLastToggle = now;
    } else if (!buzzerState && since >= offMs) {
      buzzerPin(true);
      buzzerLastToggle = now;
    }
  }
}

// ============================================================
// MQTT topics
// ============================================================
void buildTopics() {
  String base = String("pillbox/") + DEVICE_ID;
  mqttTopicCmd       = base + "/cmd";
  mqttTopicStatus    = base + "/status";
  mqttTopicTelemetry = base + "/telemetry";
  mqttTopicDose      = base + "/dose";
}

// ============================================================
// WiFi
// ============================================================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[wifi] connected, IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("\n[wifi] connection FAILED - will retry"));
  }
}

// ============================================================
// MQTT
// ============================================================
void onMqttMessage(char* topic, byte* payload, unsigned int length);

void connectMqtt() {
  if (mqtt.connected()) return;
  Serial.printf("[mqtt] connecting to %s:%u ...", MQTT_HOST, MQTT_PORT);
  String clientId = String("esp32-") + DEVICE_ID + "-" + String(random(10000));
  bool ok = (strlen(MQTT_USER) > 0)
              ? mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)
              : mqtt.connect(clientId.c_str());
  if (ok) {
    Serial.println(F(" connected"));
    mqtt.subscribe(mqttTopicCmd.c_str(), 1);
    mqtt.setCallback(onMqttMessage);
    Serial.printf("[mqtt] subscribed to %s\n", mqttTopicCmd.c_str());
  } else {
    Serial.printf(" FAILED (rc=%d)\n", mqtt.state());
  }
}

// ============================================================
// Servo helpers
// ============================================================
void servoOpen()  { trapdoorServo.write(SERVO_OPEN);   currentServoAngle = SERVO_OPEN;   Serial.println(F("[servo] OPEN"));  }
void servoClose() { trapdoorServo.write(SERVO_CLOSED); currentServoAngle = SERVO_CLOSED; Serial.println(F("[servo] CLOSE")); }

// ============================================================
// Arm / Disarm the alarm + sensor
// ============================================================
void armAlarm() {
  currentState    = STATE_ARMED;
  alarmStartTime  = millis();
  handDetected    = false;
  lastDistanceCm  = 999.0;
  buzzerAlarmStart();
  Serial.println(F("[system] ALARM ARMED - ultrasonic ACTIVE, waiting for hand"));
  Serial.printf("[system] timeout in %u ms\n", (unsigned)ALARM_TIMEOUT_MS);
}

void disarmAlarm() {
  buzzerStop();
  currentState = STATE_IDLE;
  handDetected = false;
  lastDistanceCm = 999.0;
  Serial.println(F("[system] alarm DISARMED - ultrasonic INACTIVE"));
}

// ============================================================
// Ultrasonic read (NON-blocking thanks to short pulseIn timeout)
//   Returns distance in cm, or 999.0 on timeout / no echo.
// ============================================================
float readUltrasonicCm() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(TRIG_PULSE_US);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  // 25 ms timeout keeps this effectively non-blocking for the loop
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 25000);
  if (duration == 0) {
    Serial.println(F("[ultrasonic] no echo (timeout)"));
    return 999.0;
  }
  float cm = (duration * 0.034f) / 2.0f;
  return cm;
}

// Only called while STATE_ARMED - sensor is OFF when idle.
void ultrasonicArmedUpdate() {
  if (currentState != STATE_ARMED) return;
  if (millis() - lastUltrasonicRead < ULTRASONIC_INTERVAL_MS) return;
  lastUltrasonicRead = millis();

  lastDistanceCm = readUltrasonicCm();
  bool prev = handDetected;
  handDetected = (lastDistanceCm > 0.0f && lastDistanceCm < HAND_DETECT_CM);

  if (handDetected && !prev) {
    Serial.printf("[ultrasonic] HAND detected at %.1f cm (< %u cm) -> dispense\n",
                  lastDistanceCm, (unsigned)HAND_DETECT_CM);
    // Hand found -> begin dispense sequence (non-blocking)
    startDispense();
  } else if (!prev) {
    // Still nothing in range
    Serial.printf("[ultrasonic] reading %.1f cm (no hand)\n", lastDistanceCm);
  }
}

// ============================================================
// Non-blocking dispense state machine
//   STATE_DISPENSE_OPEN  -> servoOpen, move to HOLD
//   STATE_DISPENSE_HOLD  -> wait DISPENSE_HOLD_MS using millis()
//   STATE_DISPENSE_CLOSE -> servoClose, success beep, publish dose, COOLDOWN
// ============================================================
void startDispense() {
  Serial.println(F("[dispense] START - hand detected, opening door"));
  buzzerStop();          // silence alarm before success cue
  servoOpen();
  currentState        = STATE_DISPENSE_HOLD;
  dispensePhaseStart  = millis();
}

void publishPillEvent(const char* eventName);
void publishDose();

void dispenseUpdate() {
  unsigned long now = millis();

  if (currentState == STATE_DISPENSE_HOLD) {
    if (now - dispensePhaseStart >= DISPENSE_HOLD_MS) {
      Serial.println(F("[dispense] hold complete, closing door"));
      servoClose();
      currentState       = STATE_DISPENSE_CLOSE;
      dispensePhaseStart = now;
    }
    return;
  }

  if (currentState == STATE_DISPENSE_CLOSE) {
    // Give servo a moment to finish the move, then confirm + publish.
    if (now - dispensePhaseStart >= 500) {
      buzzerBeep(BEEP_CONFIRM_MS);
      publishDose();
      publishPillEvent("pill_taken");
      currentState        = STATE_COOLDOWN;
      cooldownStartTime  = now;
      Serial.println(F("[dispense] COMPLETE - success cue + dose published"));
    }
    return;
  }
}

// ============================================================
// MQTT message handler
// ============================================================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char msg[512];
  unsigned int copyLen = min(length, (unsigned int)sizeof(msg) - 1);
  memcpy(msg, payload, copyLen);
  msg[copyLen] = '\0';
  Serial.printf("[mqtt] rx on %s: %s\n", topic, msg);

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.printf("[mqtt] JSON parse FAILED: %s\n", err.c_str());
    return;
  }

  const char* action  = doc["action"]  | "";
  const char* type    = doc["type"]    | "";

  // ----------------------------------------------------------
  // Scheduled pill time / alarm -> ARM the pillbox
  // ----------------------------------------------------------
  if (strcmp(action, "pill_time") == 0 ||
      strcmp(action, "alarm")     == 0 ||
      strcmp(type,   "alarm")     == 0) {
    if (currentState == STATE_IDLE) {
      armAlarm();
    } else {
      Serial.printf("[system] pill_time ignored - busy in state %d\n", currentState);
    }
  }

  // ----------------------------------------------------------
  // Direct dispense (web "Manual Dispense" or server schedule)
  // ----------------------------------------------------------
  else if (strcmp(action, "dispense") == 0 || strcmp(type, "dispense") == 0) {
    if (currentState == STATE_IDLE) {
      Serial.println(F("[system] manual dispense (no alarm)"));
      startDispense();
    } else if (currentState == STATE_ARMED) {
      // If alarm already ringing, treat dispense as if hand detected
      Serial.println(F("[system] dispense while armed -> triggering"));
      startDispense();
    } else {
      Serial.printf("[system] dispense ignored - busy in state %d\n", currentState);
    }
  }

  // ----------------------------------------------------------
  // Direct servo control
  // ----------------------------------------------------------
  else if (strcmp(action, "servo") == 0) {
    int position = doc["position"] | SERVO_CLOSED;
    position = constrain(position, 0, 180);
    trapdoorServo.write(position);
    currentServoAngle = position;
    Serial.printf("[servo] mqtt set %d\n", position);
  } else if (strcmp(action, "open") == 0) {
    servoOpen();
  } else if (strcmp(action, "close") == 0) {
    servoClose();
  }

  // ----------------------------------------------------------
  // Direct buzzer control
  // ----------------------------------------------------------
  else if (strcmp(action, "buzzer") == 0) {
    const char* pattern = doc["pattern"] | "off";
    int duration = doc["duration"] | 1000;
    if (strcmp(pattern, "beep") == 0) {
      buzzerBeep((uint16_t)duration);
    } else if (strcmp(pattern, "alarm") == 0) {
      // standalone alarm command does NOT arm the sensor by default;
      // use "pill_time" to arm + ring.
      buzzerAlarmStart();
    } else {
      buzzerStop();
    }
  }
}

// ============================================================
// Publishers
// ============================================================
void publishStatus() {
  StaticJsonDocument<256> doc;
  doc["type"]      = "status";
  doc["online"]   = true;
  doc["uptime"]   = millis() / 1000;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["ip"]       = WiFi.localIP().toString();
  char buf[256];
  serializeJson(doc, buf);
  mqtt.publish(mqttTopicStatus.c_str(), buf, true);
}

void publishTelemetry() {
  StaticJsonDocument<320> doc;
  doc["type"]            = "telemetry";
  doc["timestamp"]       = millis();
  doc["state"]           = (int)currentState;
  doc["pillTimeActive"]  = (currentState == STATE_ARMED);
  doc["ultrasonic"]["distance"]     = round(lastDistanceCm * 10.0) / 10.0;
  doc["ultrasonic"]["handDetected"]  = handDetected;
  doc["motors"]["servo"]["angle"]    = currentServoAngle;
  doc["buzzer"]["active"]            = buzzerState;
  char buf[320];
  serializeJson(doc, buf);
  mqtt.publish(mqttTopicTelemetry.c_str(), buf, false);
}

void publishPillEvent(const char* eventName) {
  StaticJsonDocument<256> doc;
  doc["type"]      = "event";
  doc["event"]    = eventName;
  doc["timestamp"] = millis();
  char buf[256];
  serializeJson(doc, buf);
  mqtt.publish(mqttTopicTelemetry.c_str(), buf, false);
}

void publishDose() {
  StaticJsonDocument<128> doc;
  doc["type"]         = "dose";
  doc["medicationId"] = "hand-triggered";
  doc["quantity"]     = 1;
  char buf[128];
  serializeJson(doc, buf);
  mqtt.publish(mqttTopicDose.c_str(), buf, true);
  Serial.println(F("[mqtt] dose published"));
}

// ============================================================
// Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=== Z Care ESP32 Firmware (Scheduled Pillbox) ==="));
  Serial.printf("Device ID: %s\n", DEVICE_ID);
  Serial.printf("Pins: servo=%d trig=%d echo=%d buzzer=%d (ACTIVE)\n",
                SERVO_PIN, ULTRASONIC_TRIG, ULTRASONIC_ECHO, BUZZER_PIN);
  Serial.printf("Hand threshold: %u cm | Alarm timeout: %u ms | Hold: %u ms\n",
                (unsigned)HAND_DETECT_CM, (unsigned)ALARM_TIMEOUT_MS,
                (unsigned)DISPENSE_HOLD_MS);

  buildTopics();

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  buzzerPin(false);  // make sure buzzer is OFF at boot

  trapdoorServo.attach(SERVO_PIN);
  servoClose();

  // Startup confirmation beep so we can tell the audio driver works
  Serial.println(F("[buzzer] startup test beep"));
  buzzerBeep(BUZZER_STARTUP_MS);

  connectWiFi();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  connectMqtt();

  Serial.println(F("[setup] ready - IDLE, ultrasonic INACTIVE"));
}

// ============================================================
// Main loop (non-blocking)
// ============================================================
void loop() {
  unsigned long now = millis();

  // ---- WiFi reconnect (throttled) --------------------------
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiAttempt > WIFI_RETRY_MS) {
      lastWifiAttempt = now;
      connectWiFi();
    }
  }

  // ---- MQTT reconnect (throttled) -------------------------
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected()) {
    if (now - lastMqttAttempt > MQTT_RETRY_MS) {
      lastMqttAttempt = now;
      connectMqtt();
    }
  }
  mqtt.loop();

  // ---- Buzzer driver (always runs so beeps end on time) --
  buzzerUpdate();

  // ---- State machine --------------------------------------
  switch (currentState) {

    case STATE_IDLE:
      // Ultrasonic is INACTIVE here - no reads, no dispensing.
      // (intentional: prevents accidental dispense when someone
      //  just walks past the box)
      break;

    case STATE_ARMED: {
      // 1) Read sensor (throttled, only while armed)
      ultrasonicArmedUpdate();

      // 2) Timeout / safety: silence and disarm if no hand within window
      if (now - alarmStartTime >= ALARM_TIMEOUT_MS) {
        Serial.printf("[system] ALARM TIMEOUT after %u ms with no hand - disarming\n",
                      (unsigned)ALARM_TIMEOUT_MS);
        publishPillEvent("alarm_timeout");
        disarmAlarm();
      }
      break;
    }

    case STATE_DISPENSE_HOLD:
    case STATE_DISPENSE_CLOSE:
      dispenseUpdate();
      break;

    case STATE_COOLDOWN:
      // Brief wired-down pause after a dispense before returning to idle.
      if (now - cooldownStartTime >= COOLDOWN_MS) {
        currentState = STATE_IDLE;
        Serial.println(F("[system] cooldown done -> IDLE"));
      }
      break;
  }

  // ---- Periodic status / telemetry ------------------------
  if (mqtt.connected()) {
    if (now - lastStatusSend >= STATUS_INTERVAL_MS) {
      lastStatusSend = now;
      publishStatus();
    }
    if (now - lastTelemetrySend >= TELEM_INTERVAL_MS) {
      lastTelemetrySend = now;
      publishTelemetry();
    }
  }
}
