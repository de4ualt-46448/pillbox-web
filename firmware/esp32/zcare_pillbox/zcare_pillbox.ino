/**
 * Z Care ESP32 Smart Pillbox Firmware
 * Features: MQTT, Anti-Tamper Motor Locking (Servo + Stepper), Ultrasonic Sensor
 *
 * ==========================================================================
 *  REQUIRED LIBRARIES (Arduino IDE > Sketch > Include Library > Manage Libraries):
 *    WiFi            (ESP32 built-in)
 *    PubSubClient    (Nick O'Leary)
 *    ArduinoJson     (>= 6.x)
 *    ESP32Servo      (Kevin Harrington)
 * ==========================================================================
 *
 *  MQTT Topics (per device, default "pillbox-01"):
 *    pillbox/{deviceId}/cmd        web/server -> board  {action:"dispense"|"schedule"|...}
 *    pillbox/{deviceId}/dose       board -> web/server  {type:"dose", medicationId}
 *    pillbox/{deviceId}/status     board -> web/server  {type:"status", online, uptime, ...}
 *    pillbox/{deviceId}/telemetry  board -> web/server  {type:"telemetry", ultrasonic, motors, ...}
 *    pillbox/{deviceId}/request    board -> server      {type:"getSchedule"}
 * ==========================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ============================================================
// Wi-Fi Configuration — EDIT THESE before flashing
// ============================================================
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ============================================================
// MQTT Mode — uncomment ONE block below
// ============================================================
//
// --- LOCAL DEV (server runs "npm run dev" on your computer) ---
// Set MQTT_HOST to your computer's LAN IP (find with: ipconfig / ifconfig / hostname -I)
//
#define MQTT_LOCAL
#ifdef MQTT_LOCAL
const char* MQTT_HOST   = "192.168.1.5";   // <-- CHANGE to your computer's LAN IP
const uint16_t MQTT_PORT = 1883;            // local aedes broker
#endif
//
// --- DEPLOYMENT (server uses an external broker like HiveMQ) ---
// Server's MQTT_BROKER_URL env var must point to the same broker.
//
// #define MQTT_DEPLOY
// #ifdef MQTT_DEPLOY
// const char* MQTT_HOST   = "broker.hivemq.com";
// const uint16_t MQTT_PORT = 1883;
// #endif

const char* DEVICE_ID = "pillbox-01";

WiFiClient  wifiClient;
PubSubClient mqttClient(wifiClient);

// MQTT topics
String mqttTopicCmd;
String mqttTopicStatus;
String mqttTopicTelemetry;
String mqttTopicDose;
String mqttTopicRequest;

// ============================================================
// Pin Definitions
// ============================================================
#define SERVO_PIN       23
#define ULTRASONIC_TRIG 18
#define ULTRASONIC_ECHO 19
#define BUZZER_PIN      4

// Stepper Motor Pins (ULN2003 Driver)
#define STEPPER_IN1     13
#define STEPPER_IN2     12
#define STEPPER_IN3     14
#define STEPPER_IN4     27

// ============================================================
// Tunable Constants
// ============================================================
#define SERVO_CLOSED        0
#define SERVO_OPEN          90
#define HAND_DETECT_CM      10.0
#define DISPENSE_HOLD_MS    3000
#define DISPENSE_CLOSE_MS   500
#define COOLDOWN_MS         3000
#define ALARM_TIMEOUT_MS    (5UL * 60UL * 1000UL)
#define ALARM_TICK_ON_US    300
#define ALARM_TICK_OFF_US   200
#define BEEP_CONFIRM_MS     300

#define STATUS_INTERVAL_MS     10000
#define TELEM_INTERVAL_MS      2000
#define MQTT_RETRY_MS          5000
#define WIFI_RETRY_MS          15000
#define ULTRASONIC_INTERVAL_MS 100

// ============================================================
// State Machine
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

// ============================================================
// Global Objects & State Variables
// ============================================================
Servo trapdoorServo;

bool  pillTimeActive      = false;
float currentDistanceCm    = 999.0;
bool  handDetected        = false;
int   currentServoAngle   = SERVO_CLOSED;
String lastMedicationId   = "hand-triggered";

// Stepper Position Tracking
int currentStepPhase = 0;
const int stepSequence[4][4] = {
  {HIGH, LOW,  LOW,  LOW},
  {LOW,  HIGH, LOW,  LOW},
  {LOW,  LOW,  HIGH, LOW},
  {LOW,  LOW,  LOW,  HIGH}
};

// Non-blocking timing
unsigned long alarmStartTime     = 0;
unsigned long dispensePhaseStart = 0;
unsigned long cooldownStartTime  = 0;
unsigned long lastSensorRead     = 0;
unsigned long lastMqttRetry      = 0;
unsigned long lastWifiRetry      = 0;
unsigned long lastStatusPub      = 0;
unsigned long lastTelemetryPub   = 0;
unsigned long lastPositionEnforce = 0;

// ============================================================
// Buzzer (ACTIVE) — non-blocking
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
  if (buzzerPattern != 0 || buzzerState) Serial.println(F("[buzzer] OFF"));
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
// Stepper Motor Functions
// ============================================================
void lockStepperPosition() {
  digitalWrite(STEPPER_IN1, stepSequence[currentStepPhase][0]);
  digitalWrite(STEPPER_IN2, stepSequence[currentStepPhase][1]);
  digitalWrite(STEPPER_IN3, stepSequence[currentStepPhase][2]);
  digitalWrite(STEPPER_IN4, stepSequence[currentStepPhase][3]);
}

void stepCarousel(int steps, int speedMs) {
  int direction = (steps > 0) ? 1 : -1;
  steps = abs(steps);
  for (int i = 0; i < steps; i++) {
    currentStepPhase = (currentStepPhase + direction + 4) % 4;
    lockStepperPosition();
    delay(speedMs);
  }
}

// ============================================================
// Servo Control (with anti-force holding)
// ============================================================
void lockServoPosition() {
  trapdoorServo.write(currentServoAngle);
}

void servoOpen() {
  currentServoAngle = SERVO_OPEN;
  trapdoorServo.write(SERVO_OPEN);
  Serial.println(F("[Servo] OPEN"));
}

void servoClose() {
  currentServoAngle = SERVO_CLOSED;
  trapdoorServo.write(SERVO_CLOSED);
  Serial.println(F("[Servo] CLOSE"));
}

// ============================================================
// MQTT Topics
// ============================================================
void buildMqttTopics() {
  String base = String("pillbox/") + DEVICE_ID;
  mqttTopicCmd       = base + "/cmd";
  mqttTopicStatus    = base + "/status";
  mqttTopicTelemetry = base + "/telemetry";
  mqttTopicDose      = base + "/dose";
  mqttTopicRequest   = base + "/request";
}

// ============================================================
// Ultrasonic
// ============================================================
float getDistanceCm() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 25000);
  if (duration == 0) return 999.0;
  return (duration * 0.034) / 2.0;
}

void ultrasonicArmedUpdate() {
  if (currentState != STATE_ARMED) return;
  if (millis() - lastSensorRead < ULTRASONIC_INTERVAL_MS) return;
  lastSensorRead = millis();

  currentDistanceCm = getDistanceCm();
  bool prev = handDetected;
  handDetected = (currentDistanceCm > 0 && currentDistanceCm < HAND_DETECT_CM);

  if (handDetected && !prev) {
    Serial.printf("[ultrasonic] HAND at %.1f cm -> dispense\n", currentDistanceCm);
    startDispense();
  }
}

// ============================================================
// Arm / Disarm
// ============================================================
void armAlarm() {
  currentState    = STATE_ARMED;
  alarmStartTime  = millis();
  pillTimeActive  = true;
  handDetected    = false;
  currentDistanceCm = 999.0;
  buzzerAlarmStart();
  Serial.println(F("[system] ALARM ARMED - ultrasonic ACTIVE"));
}

void disarmAlarm() {
  buzzerStop();
  currentState     = STATE_IDLE;
  pillTimeActive   = false;
  handDetected     = false;
  currentDistanceCm = 999.0;
  Serial.println(F("[system] ALARM DISARMED"));
}

// ============================================================
// Non-blocking dispense
// ============================================================
void publishDose();

void startDispense() {
  Serial.println(F("[dispense] START - opening trapdoor, rotating carousel"));
  buzzerStop();

  // Rotate stepper to next compartment
  stepCarousel(512, 3);
  delay(200);

  servoOpen();
  currentServoAngle  = SERVO_OPEN;
  currentState       = STATE_DISPENSE_HOLD;
  dispensePhaseStart = millis();
}

void dispenseUpdate() {
  unsigned long now = millis();

  if (currentState == STATE_DISPENSE_HOLD) {
    if (now - dispensePhaseStart >= DISPENSE_HOLD_MS) {
      Serial.println(F("[dispense] hold complete, closing trapdoor"));
      servoClose();
      currentState       = STATE_DISPENSE_CLOSE;
      dispensePhaseStart = now;
    }
    return;
  }

  if (currentState == STATE_DISPENSE_CLOSE) {
    if (now - dispensePhaseStart >= DISPENSE_CLOSE_MS) {
      lockStepperPosition();
      buzzerBeep(BEEP_CONFIRM_MS);
      publishDose();
      currentState       = STATE_COOLDOWN;
      cooldownStartTime  = now;
      pillTimeActive     = false;
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
  StaticJsonDocument<384> doc;
  doc["type"]             = "telemetry";
  doc["timestamp"]        = millis();
  doc["state"]            = (int)currentState;
  doc["pillTimeActive"]   = (currentState == STATE_ARMED);
  doc["ultrasonic"]["distance"]    = round(currentDistanceCm * 10.0) / 10.0;
  doc["ultrasonic"]["handDetected"] = handDetected;
  doc["motors"]["servo"]["angle"]   = currentServoAngle;
  doc["motors"]["stepper"]["moving"] = (currentState == STATE_DISPENSE_OPEN);
  doc["motors"]["stepper"]["position"] = currentStepPhase;
  doc["buzzer"]["active"]           = buzzerState;
  doc["medSlotCount"] = 4;
  char buf[384];
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

void publishScheduleRequest() {
  StaticJsonDocument<64> doc;
  doc["type"] = "getSchedule";
  char buf[64];
  serializeJson(doc, buf);
  mqttClient.publish(mqttTopicRequest.c_str(), buf, true);
  Serial.println(F("[mqtt] schedule request published"));
}

// ============================================================
// MQTT message handler
// ============================================================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char msg[512];
  unsigned int copyLen = min(length, (unsigned int)sizeof(msg) - 1);
  memcpy(msg, payload, copyLen);
  msg[copyLen] = '\0';

  Serial.printf("[MQTT] Received: %s\n", msg);

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.printf("[mqtt] JSON parse FAILED: %s\n", err.c_str());
    return;
  }

  const char* type   = doc["type"]   | "";
  const char* action = doc["action"] | "";

  // ---- Alarm / pill time -> ARM ----
  if (strcmp(action, "pill_time") == 0 ||
      strcmp(action, "alarm")     == 0 ||
      strcmp(type,   "alarm")     == 0) {
    if (currentState == STATE_IDLE) {
      armAlarm();
    } else {
      Serial.printf("[system] alarm ignored - busy in state %d\n", currentState);
    }
  }

  // ---- Dispense ----
  else if (strcmp(action, "dispense") == 0 || strcmp(type, "dispense") == 0) {
    if (currentState == STATE_IDLE || currentState == STATE_ARMED) {
      if (doc.containsKey("medicationId")) {
        lastMedicationId = String((const char*)doc["medicationId"]);
        Serial.printf("[system] storing medicationId %s\n", lastMedicationId.c_str());
      }
      startDispense();
    } else {
      Serial.printf("[system] dispense ignored - busy in state %d\n", currentState);
    }
  }

  // ---- Schedule (store meds list) ----
  else if (strcmp(action, "schedule") == 0) {
    Serial.println(F("[mqtt] schedule received"));
    // Schedule is stored by the server; board just acknowledges receipt.
  }

  // ---- Buzzer ----
  else if (strcmp(action, "buzzer") == 0) {
    const char* pattern = doc["pattern"] | "off";
    int duration = doc["duration"] | 1000;
    if (strcmp(pattern, "beep") == 0) {
      buzzerBeep((uint16_t)duration);
    } else if (strcmp(pattern, "alarm") == 0) {
      buzzerAlarmStart();
    } else {
      buzzerStop();
    }
  }

  // ---- Servo direct ----
  else if (strcmp(action, "servo") == 0) {
    int pos = doc["position"] | SERVO_CLOSED;
    pos = constrain(pos, 0, 180);
    trapdoorServo.write(pos);
    currentServoAngle = pos;
    Serial.printf("[Servo] MQTT set to %d\n", pos);
  } else if (strcmp(action, "open") == 0) {
    servoOpen();
  } else if (strcmp(action, "close") == 0) {
    servoClose();
  }

  // ---- Stepper rotate ----
  else if (strcmp(action, "rotate") == 0) {
    int steps = doc["steps"] | 512;
    stepCarousel(steps, 3);
    lockStepperPosition();
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
    // Request schedule on first connect
    publishScheduleRequest();
  } else {
    Serial.printf(" failed (rc=%d)\n", mqttClient.state());
  }
}

// ============================================================
// Setup
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(F("\n=== Z Care ESP32 Pillbox (MQTT) ==="));
#ifdef MQTT_LOCAL
  Serial.println(F("Mode: LOCAL DEV"));
#elif defined(MQTT_DEPLOY)
  Serial.println(F("Mode: DEPLOYMENT"));
#endif
  Serial.printf("MQTT Host: %s:%u\n", MQTT_HOST, MQTT_PORT);
  Serial.printf("Device ID: %s\n", DEVICE_ID);

  // Pin Setup
  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  buzzerPin(false);

  pinMode(STEPPER_IN1, OUTPUT);
  pinMode(STEPPER_IN2, OUTPUT);
  pinMode(STEPPER_IN3, OUTPUT);
  pinMode(STEPPER_IN4, OUTPUT);

  trapdoorServo.attach(SERVO_PIN);
  servoClose();
  lockStepperPosition();

  buildMqttTopics();

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(512);

  // WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("\n[WiFi] Timed out - will retry"));
  }

  connectMqtt();

  Serial.println(F("[buzzer] startup beep"));
  buzzerBeep(150);
  Serial.println(F("[System] Ready - IDLE, ultrasonic INACTIVE"));
}

// ============================================================
// Main Loop (non-blocking)
// ============================================================
void loop() {
  unsigned long now = millis();

  // WiFi reconnect
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiRetry > WIFI_RETRY_MS) {
      lastWifiRetry = now;
      WiFi.reconnect();
    }
  }

  // MQTT reconnect
  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected()) {
    if (now - lastMqttRetry > MQTT_RETRY_MS) {
      lastMqttRetry = now;
      connectMqtt();
    }
  }
  mqttClient.loop();

  buzzerUpdate();

  switch (currentState) {
    case STATE_IDLE:
      break;

    case STATE_ARMED:
      ultrasonicArmedUpdate();
      if (now - alarmStartTime >= ALARM_TIMEOUT_MS) {
        Serial.printf("[system] ALARM TIMEOUT after %u ms\n", (unsigned)ALARM_TIMEOUT_MS);
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

  // Anti-tamper: periodically re-enforce motor positions
  if (now - lastPositionEnforce >= 500) {
    lastPositionEnforce = now;
    lockServoPosition();
    lockStepperPosition();
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
