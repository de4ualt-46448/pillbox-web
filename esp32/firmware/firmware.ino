/**
 * Z Care Smart Pillbox - WiFi + MQTT + Web Dashboard Enabled
 *
 * ==========================================================================
 *  HARDWARE PIN ASSIGNMENTS  (edit here if your wiring differs)
 * ==========================================================================
 *    ESP32 DevKit V1
 *    Servo Motor (carousel/trapdoor) .... GPIO 23
 *    HC-SR04 Ultrasonic Sensor
 *       - TRIG .......................... GPIO 18
 *       - ECHO .......................... GPIO 19  (use divider for 5V echo)
 *    Buzzer ........................... GPIO 4   (ACTIVE buzzer, 1k resistor)
 *
 *  NOTE: Buzzer is an ACTIVE type (sounds when pin is HIGH).
 *        If you switch to a PASSIVE buzzer, replace digitalWrite() calls in
 *        buzzerPin() with tone()/noTone() and remove the alarm tick logic.
 *
 * ==========================================================================
 *  REQUIRED LIBRARIES  (Arduino IDE / PlatformIO)
 * ==========================================================================
 *    WiFi            (ESP32 built-in)
 *    WebServer       (ESP32 built-in)
 *    ESP32Servo      (Kevin Harrington's ESP32Servo - replaces 'Servo')
 *    PubSubClient    (Nick O'Leary MQTT client)
 *    ArduinoJson     (>= 6.x)
 *
 * ==========================================================================
 *  FLOW
 * ==========================================================================
 *    - IDLE: ultrasonic INACTIVE - walking past the box never dispenses.
 *    - A schedule trigger arrives via MQTT {"action":"pill_time"/"alarm"} or
 *      {"type":"alarm"}, OR via the local web dashboard "Manual Dispense".
 *      The pillbox then enters STATE_ARMED:
 *         1. Buzzer rings (non-blocking alarm tick pattern).
 *         2. Ultrasonic sensor is ARMED and starts measuring distance.
 *         3. If a hand is detected (< HAND_DETECT_CM) the servo opens, the
 *            pill is taken, the servo closes and the alarm silences.
 *         4. After ALARM_TIMEOUT_MS with no hand, the alarm auto-disarms.
 * ==========================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ============================================================
// Wi-Fi Configuration — EDIT THESE before flashing
// ============================================================
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

WebServer httpServer(80);

// ============================================================
// MQTT Mode — uncomment ONE of the two blocks below
// ============================================================
//
// --- LOCAL DEV (server runs `npm run dev` on your computer) ---
// Set MQTT_HOST to your computer's local IP (e.g. 192.168.1.x).
// Find it: Windows → ipconfig, macOS → ifconfig, Linux → hostname -I.
//
#define MQTT_LOCAL
#ifdef MQTT_LOCAL
const char* MQTT_HOST   = "192.168.1.5";   // <-- CHANGE to your computer's LAN IP
const uint16_t MQTT_PORT = 1883;            // local aedes broker
#endif
//
// --- DEPLOYMENT (server uses an external broker like HiveMQ) ---
// The server's MQTT_BROKER_URL env var must point to the same broker.
// No credentials needed for HiveMQ public broker.
//
// #define MQTT_DEPLOY
// #ifdef MQTT_DEPLOY
// const char* MQTT_HOST   = "broker.hivemq.com";
// const uint16_t MQTT_PORT = 1883;
// #endif

const char* DEVICE_ID    = "pillbox-01";

WiFiClient    wifiClient;
PubSubClient  mqttClient(wifiClient);

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
// Tunable Constants
// ============================================================
#define HAND_DETECT_CM      10.0          // < this distance (cm) => hand present
#define DETECT_DISTANCE_CM  HAND_DETECT_CM // alias kept for telemetry compat
#define SERVO_CLOSED        0
#define SERVO_OPEN          90
#define DISPENSE_HOLD_MS    3000           // door stays open while user takes pill
#define DISPENSE_CLOSE_MS   500            // time for servo return to closed
#define COOLDOWN_MS         3000           // brief lockout after a dispense

// ---- Alarm / timeout (per Issue 2) ---------------------------
#define ALARM_TIMEOUT_MS  (5UL * 60UL * 1000UL)  // 5 minutes, configurable
#define ALARM_TICK_ON_US   300
#define ALARM_TICK_OFF_US  200
#define BEEP_CONFIRM_MS    300

#define STATUS_INTERVAL_MS     10000
#define TELEM_INTERVAL_MS      2000
#define MQTT_RETRY_MS          5000
#define WIFI_RETRY_MS          15000
#define ULTRASONIC_INTERVAL_MS 100

// Track the last medicationId from a dispense command
String lastMedicationId = "hand-triggered";

// ============================================================
// State Machine
//   IDLE         -> waiting for next scheduled time, sensor OFF
//   ARMED        -> alarm ringing + sensor ON, waiting for hand
//   DISPENSE_*   -> non-blocking servo open/hold/close sequence
//   COOLDOWN     -> brief post-dispense lockout
// ============================================================
enum PillboxState {
  STATE_IDLE,
  STATE_ARMED,
  STATE_DISPENSE_OPEN,
  STATE_DISPENSE_HOLD,
  STATE_DISPENSE_CLOSE,
  STATE_COOLDOWN
};

PillboxState currentState = STATE_IDLE;

// --- non-blocking timing --------------------------------------
unsigned long alarmStartTime    = 0;
unsigned long dispensePhaseStart = 0;
unsigned long cooldownStartTime = 0;
unsigned long lastSensorRead    = 0;
unsigned long lastMqttRetry     = 0;
unsigned long lastWifiRetry     = 0;
unsigned long lastStatusPub     = 0;
unsigned long lastTelemetryPub  = 0;

float currentDistanceCm = 999.0;
bool  handDetected      = false;
int   currentServoAngle = SERVO_CLOSED;

Servo pillServo;

// ============================================================
// Buzzer (ACTIVE) - non-blocking driver
//   Pattern 0 = off
//   Pattern 1 = finite single beep (auto-off)
//   Pattern 2 = repeating alarm tick (runs until buzzerStop)
// ============================================================
uint8_t       buzzerPattern    = 0;
bool          buzzerState      = false;
unsigned long buzzerBeepStart  = 0;
unsigned long buzzerBeepDur    = 0;
unsigned long buzzerLastToggle = 0;

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

void buzzerBeep(uint16_t durationMs) {
  buzzerPattern   = 1;
  buzzerBeepStart = millis();
  buzzerBeepDur   = durationMs;
  buzzerPin(true);
  Serial.printf("[buzzer] beep start (%ums)\n", durationMs);
}

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
    if (now - buzzerBeepStart >= buzzerBeepDur) {
      buzzerPin(false);
      buzzerPattern = 0;
      Serial.println(F("[buzzer] beep finished"));
    }
    return;
  }

  if (buzzerPattern == 2) {
    unsigned long onMs  = (ALARM_TICK_ON_US  + 999) / 1000; if (onMs  == 0) onMs  = 1;
    unsigned long offMs = (ALARM_TICK_OFF_US + 999) / 1000; if (offMs == 0) offMs = 1;
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
void buildMqttTopics() {
  String base = String("pillbox/") + DEVICE_ID;
  mqttTopicCmd       = base + "/cmd";
  mqttTopicStatus    = base + "/status";
  mqttTopicTelemetry = base + "/telemetry";
  mqttTopicDose      = base + "/dose";
}

// ============================================================
// Ultrasonic read  (non-blocking thanks to short pulseIn timeout)
// ============================================================
float getDistanceCm() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);

  long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 25000); // 25ms timeout
  if (duration == 0) {
    Serial.println(F("[ultrasonic] no echo (timeout)"));
    return 999.0;
  }
  return (duration * 0.034) / 2.0;
}

// Only called while STATE_ARMED - sensor is OFF when idle.
void ultrasonicArmedUpdate() {
  if (currentState != STATE_ARMED) return;
  if (millis() - lastSensorRead < ULTRASONIC_INTERVAL_MS) return;
  lastSensorRead = millis();

  currentDistanceCm = getDistanceCm();
  bool prev = handDetected;
  handDetected = (currentDistanceCm > 0 && currentDistanceCm < HAND_DETECT_CM);

  if (handDetected && !prev) {
    Serial.printf("[ultrasonic] HAND at %.1f cm (< %u cm) -> dispense\n",
                  currentDistanceCm, (unsigned)HAND_DETECT_CM);
    startDispense();
  } else if (!prev) {
    Serial.printf("[ultrasonic] reading %.1f cm (no hand)\n", currentDistanceCm);
  }
}

// ============================================================
// Arm / Disarm the alarm + sensor
// ============================================================
void armAlarm() {
  currentState    = STATE_ARMED;
  alarmStartTime  = millis();
  handDetected    = false;
  currentDistanceCm = 999.0;
  buzzerAlarmStart();
  Serial.println(F("[system] ALARM ARMED - ultrasonic ACTIVE"));
  Serial.printf("[system] timeout in %u ms\n", (unsigned)ALARM_TIMEOUT_MS);
}

void disarmAlarm() {
  buzzerStop();
  currentState     = STATE_IDLE;
  handDetected     = false;
  currentDistanceCm = 999.0;
  Serial.println(F("[system] alarm DISARMED - ultrasonic INACTIVE"));
}

// ============================================================
// Non-blocking dispense state machine
// ============================================================
void publishDose();

void startDispense() {
  Serial.println(F("[dispense] START - hand detected, opening door"));
  buzzerStop();
  pillServo.write(SERVO_OPEN);
  currentServoAngle  = SERVO_OPEN;
  currentState       = STATE_DISPENSE_HOLD;
  dispensePhaseStart = millis();
}

void dispenseUpdate() {
  unsigned long now = millis();

  if (currentState == STATE_DISPENSE_HOLD) {
    if (now - dispensePhaseStart >= DISPENSE_HOLD_MS) {
      Serial.println(F("[dispense] hold complete, closing door"));
      pillServo.write(SERVO_CLOSED);
      currentServoAngle  = SERVO_CLOSED;
      currentState       = STATE_DISPENSE_CLOSE;
      dispensePhaseStart = now;
    }
    return;
  }

  if (currentState == STATE_DISPENSE_CLOSE) {
    if (now - dispensePhaseStart >= DISPENSE_CLOSE_MS) {
      buzzerBeep(BEEP_CONFIRM_MS);
      publishDose();
      currentState       = STATE_COOLDOWN;
      cooldownStartTime = now;
      Serial.println(F("[dispense] COMPLETE - dose published"));
    }
    return;
  }
}

// ============================================================
// MQTT publishers
// ============================================================
void publishStatus() {
  StaticJsonDocument<256> doc;
  doc["type"]     = "status";
  doc["online"]   = true;
  doc["uptime"]   = millis() / 1000;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["ip"]       = WiFi.localIP().toString();
  char buf[256];
  serializeJson(doc, buf);
  mqttClient.publish(mqttTopicStatus.c_str(), buf, true);
}

void publishTelemetry() {
  StaticJsonDocument<320> doc;
  doc["type"]             = "telemetry";
  doc["timestamp"]        = millis();
  doc["state"]            = (int)currentState;
  doc["pillTimeActive"]   = (currentState == STATE_ARMED);
  doc["ultrasonic"]["distance"]    = round(currentDistanceCm * 10.0) / 10.0;
  doc["ultrasonic"]["handDetected"] = handDetected;
  doc["motors"]["servo"]["angle"]   = currentServoAngle;
  doc["buzzer"]["active"]           = buzzerState;
  char buf[320];
  serializeJson(doc, buf);
  mqttClient.publish(mqttTopicTelemetry.c_str(), buf, false);
}

void publishDose() {
  StaticJsonDocument<128> doc;
  doc["type"]         = "dose";
  doc["medicationId"] = lastMedicationId;
  doc["quantity"]     = 1;
  char buf[128];
  serializeJson(doc, buf);
  mqttClient.publish(mqttTopicDose.c_str(), buf, true);
  Serial.println(F("[mqtt] dose published"));
}

// ============================================================
// MQTT message handler
// ============================================================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char msg[256];
  unsigned int copyLen = min(length, (unsigned int)sizeof(msg) - 1);
  memcpy(msg, payload, copyLen);
  msg[copyLen] = '\0';

  Serial.printf("[MQTT] Received: %s\n", msg);

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.printf("[mqtt] JSON parse FAILED: %s\n", err.c_str());
    return;
  }

  const char* type   = doc["type"]   | "";
  const char* action = doc["action"] | "";

  // --------------------------------------------------------
  // Alarm / scheduled pill time -> ARM the box
  // --------------------------------------------------------
  if (strcmp(action, "pill_time") == 0 ||
      strcmp(action, "alarm")     == 0 ||
      strcmp(type,   "alarm")     == 0) {
    if (currentState == STATE_IDLE) {
      armAlarm();
    } else {
      Serial.printf("[system] alarm ignored - busy in state %d\n", currentState);
    }
  }

  // --------------------------------------------------------
  // Dispense (manual or server schedule)
  // --------------------------------------------------------
  else if (strcmp(action, "dispense") == 0 || strcmp(type, "dispense") == 0) {
    if (currentState == STATE_IDLE || currentState == STATE_ARMED) {
      if (doc.containsKey("medicationId")) {
        lastMedicationId = String((const char*)doc["medicationId"]);
        Serial.printf("[system] storing medicationId %s\n", lastMedicationId.c_str());
      }
      if (currentState == STATE_ARMED) {
        Serial.println(F("[system] dispense while armed -> triggering"));
      } else {
        Serial.println(F("[system] manual dispense (no alarm)"));
      }
      startDispense();
    } else {
      Serial.printf("[system] dispense ignored - busy in state %d\n", currentState);
    }
  }

  // --------------------------------------------------------
  // Direct buzzer command
  // --------------------------------------------------------
  else if (strcmp(action, "buzzer") == 0) {
    const char* pattern = doc["pattern"] | "off";
    int duration = doc["duration"] | 1000;
    if (strcmp(pattern, "beep") == 0) {
      buzzerBeep((uint16_t)duration);
    } else if (strcmp(pattern, "alarm") == 0) {
      buzzerAlarmStart();   // does NOT arm sensor; use "pill_time" to arm
    } else {
      buzzerStop();
    }
  }

  // --------------------------------------------------------
  // Direct servo
  // --------------------------------------------------------
  else if (strcmp(action, "servo") == 0) {
    int pos = doc["position"] | SERVO_CLOSED;
    pos = constrain(pos, 0, 180);
    pillServo.write(pos);
    currentServoAngle = pos;
    Serial.printf("[Servo] MQTT set to %d\n", pos);
  } else if (strcmp(action, "open") == 0) {
    pillServo.write(SERVO_OPEN);
    currentServoAngle = SERVO_OPEN;
    Serial.println(F("[Servo] OPEN"));
  } else if (strcmp(action, "close") == 0) {
    pillServo.write(SERVO_CLOSED);
    currentServoAngle = SERVO_CLOSED;
    Serial.println(F("[Servo] CLOSE"));
  }
}

// ============================================================
// MQTT connection
// ============================================================
void connectMqtt() {
  if (mqttClient.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  String clientId = String("esp32-") + DEVICE_ID + "-" + String(random(10000));
  Serial.printf("[MQTT] Connecting to %s:%u ...", MQTT_HOST, MQTT_PORT);

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println(" connected");
    mqttClient.subscribe(mqttTopicCmd.c_str(), 1);
    mqttClient.setCallback(onMqttMessage);
    Serial.printf("[MQTT] Subscribed to %s\n", mqttTopicCmd.c_str());
    publishStatus();
  } else {
    Serial.printf(" failed (rc=%d)\n", mqttClient.state());
  }
}

// ============================================================
// Web dashboard routes
// ============================================================
void handleRoot() {
  String stateStr;
  switch (currentState) {
    case STATE_IDLE:           stateStr = "IDLE (Ready, sensor OFF)"; break;
    case STATE_ARMED:          stateStr = "ARMED (alarm ringing, sensor ON)"; break;
    case STATE_DISPENSE_OPEN:  stateStr = "DISPENSING (opening)"; break;
    case STATE_DISPENSE_HOLD:  stateStr = "DISPENSING (door open)"; break;
    case STATE_DISPENSE_CLOSE: stateStr = "DISPENSING (closing)"; break;
    case STATE_COOLDOWN:        stateStr = "COOLDOWN"; break;
    default:                    stateStr = "UNKNOWN"; break;
  }

  String html = "<html><head><meta name='viewport' content='width=device-width, initial-scale=1'>";
  html += "<style>body{font-family:sans-serif;text-align:center;padding:20px;background:#121212;color:#fff;}";
  html += ".btn{background:#00e676;color:#000;padding:15px 25px;border:none;border-radius:8px;font-size:18px;font-weight:bold;cursor:pointer;margin:6px;}";
  html += ".warn{background:#ff5252;color:#fff;}";
  html += ".card{background:#1e1e1e;padding:20px;border-radius:12px;max-width:440px;margin:auto;box-shadow:0 4px 10px rgba(0,0,0,0.5);}</style></head><body>";
  html += "<div class='card'>";
  html += "<h2>💊 Z Care Pillbox</h2>";
  html += "<p><strong>MQTT:</strong> " + String(mqttClient.connected() ? "Connected" : "Disconnected") + "</p>";
  html += "<p><strong>State:</strong> " + stateStr + "</p>";
  if (currentState == STATE_ARMED) {
    unsigned long remaining = (ALARM_TIMEOUT_MS - (millis() - alarmStartTime)) / 1000;
    html += "<p><strong>Alarm timeout in:</strong> " + String((long)remaining) + " s</p>";
    html += "<p><strong>Sensor:</strong> " + String(currentDistanceCm, 1) + " cm</p>";
  } else {
    html += "<p><strong>Sensor:</strong> inactive (idle)</p>";
  }
  if (currentState == STATE_IDLE) {
    html += "<form action='/arm' method='POST'><button class='btn'>Arm Alarm (test)</button></form>";
    html += "<form action='/dispense' method='POST'><button class='btn'>Manual Dispense</button></form>";
  } else if (currentState == STATE_ARMED) {
    html += "<form action='/dispense' method='POST'><button class='btn'>Dispense Now</button></form>";
    html += "<form action='/disarm' method='POST'><button class='btn warn'>Disarm Alarm</button></form>";
  } else {
    html += "<p style='color:#ff5252;'>Busy - please wait</p>";
  }
  html += "</div></body></html>";

  httpServer.send(200, "text/html", html);
}

void handleArm() {
  if (currentState == STATE_IDLE) {
    armAlarm();
    httpServer.send(200, "text/plain", "Alarm ARMED.");
  } else {
    httpServer.send(400, "text/plain", "Not idle.");
  }
}

void handleDisarm() {
  if (currentState == STATE_ARMED) {
    disarmAlarm();
    httpServer.send(200, "text/plain", "Alarm DISARMED.");
  } else {
    httpServer.send(400, "text/plain", "Not armed.");
  }
}

void handleManualDispense() {
  if (currentState == STATE_IDLE || currentState == STATE_ARMED) {
    httpServer.send(200, "text/plain", "Dispensing started!");
    startDispense();
  } else {
    httpServer.send(400, "text/plain", "Pillbox is currently busy.");
  }
}

// ============================================================
// Wi-Fi connection
// ============================================================
void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP Address: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("\n[WiFi] Connection timed out - will retry"));
  }

  httpServer.on("/",          HTTP_GET,  handleRoot);
  httpServer.on("/arm",       HTTP_POST, handleArm);
  httpServer.on("/disarm",    HTTP_POST, handleDisarm);
  httpServer.on("/dispense",  HTTP_POST, handleManualDispense);
  httpServer.begin();
  Serial.println(F("[Web] HTTP Server started."));
}

// ============================================================
// Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=== Z Care WiFi + MQTT Smart Pillbox ==="));
#ifdef MQTT_LOCAL
  Serial.println(F("Mode: LOCAL DEV (connects to your computer's MQTT broker)"));
#elif defined(MQTT_DEPLOY)
  Serial.println(F("Mode: DEPLOYMENT (connects to external MQTT broker)"));
#endif
  Serial.printf("MQTT Host: %s:%u\n", MQTT_HOST, MQTT_PORT);
  Serial.printf("Pins: servo=%d trig=%d echo=%d buzzer=%d (ACTIVE)\n",
                SERVO_PIN, ULTRASONIC_TRIG, ULTRASONIC_ECHO, BUZZER_PIN);
  Serial.printf("Hand threshold: %u cm | Alarm timeout: %u ms | Hold: %u ms\n",
                (unsigned)HAND_DETECT_CM, (unsigned)ALARM_TIMEOUT_MS,
                (unsigned)DISPENSE_HOLD_MS);

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  buzzerPin(false);  // ensure buzzer OFF at boot

  pillServo.attach(SERVO_PIN);
  pillServo.write(SERVO_CLOSED);

  buildMqttTopics();

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(512);

  setupWiFi();
  connectMqtt();

  // Startup confirmation beep so we can tell the audio driver works
  Serial.println(F("[buzzer] startup test beep"));
  buzzerBeep(150);

  Serial.println(F("[System] Ready - IDLE, ultrasonic INACTIVE"));
}

// ============================================================
// Main loop (non-blocking)
// ============================================================
void loop() {
  unsigned long now = millis();

  httpServer.handleClient();

  // WiFi reconnect (throttled)
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiRetry > WIFI_RETRY_MS) {
      lastWifiRetry = now;
      WiFi.reconnect();
    }
  }

  // MQTT reconnect (throttled)
  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected()) {
    if (now - lastMqttRetry > MQTT_RETRY_MS) {
      lastMqttRetry = now;
      connectMqtt();
    }
  }
  mqttClient.loop();

  // Buzzer driver (always runs so beeps end on time)
  buzzerUpdate();

  // State machine
  switch (currentState) {

    case STATE_IDLE:
      // Ultrasonic INACTIVE - no reads, no dispensing.
      break;

    case STATE_ARMED:
      ultrasonicArmedUpdate();
      if (now - alarmStartTime >= ALARM_TIMEOUT_MS) {
        Serial.printf("[system] ALARM TIMEOUT after %u ms - disarming\n",
                      (unsigned)ALARM_TIMEOUT_MS);
        disarmAlarm();
      }
      break;

    case STATE_DISPENSE_HOLD:
    case STATE_DISPENSE_CLOSE:
      dispenseUpdate();
      break;

    case STATE_COOLDOWN:
      if (now - cooldownStartTime >= COOLDOWN_MS) {
        currentState = STATE_IDLE;
        Serial.println(F("[System] cooldown done -> IDLE"));
      }
      break;
  }

  // Periodic status / telemetry
  if (mqttClient.connected()) {
    if (now - lastStatusPub >= STATUS_INTERVAL_MS) {
      lastStatusPub = now;
      publishStatus();
    }
    if (now - lastTelemetryPub >= TELEM_INTERVAL_MS) {
      lastTelemetryPub = now;
      publishTelemetry();
    }
  }
}
