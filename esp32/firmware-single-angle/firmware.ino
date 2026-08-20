/*
 * Z Care ESP32 Smart Pillbox - Single Angle Per Hand Detection + MQTT
 *
 * This firmware keeps the user's single-angle carousel workflow and adds an
 * MQTT control/telemetry layer compatible with the Pillbox web application.
 *
 * Hardware connections:
 *   Servo motor (trapdoor): GPIO 22
 *   HC-SR04 sensor: TRIG GPIO 18, ECHO GPIO 19
 *   Buzzer: GPIO 4
 *   Stepper ULN2003: IN1=13, IN2=16, IN3=14, IN4=27
 *
 * MQTT topics:
 *   pillbox/{DEVICE_ID}/cmd       web/server -> ESP32
 *   pillbox/{DEVICE_ID}/request   ESP32 -> server
 *   pillbox/{DEVICE_ID}/dose      ESP32 -> web/server
 *   pillbox/{DEVICE_ID}/status    ESP32 -> web/server (retained)
 *   pillbox/{DEVICE_ID}/telemetry ESP32 -> web/server
 *   pillbox/{DEVICE_ID}/event     ESP32 -> web/server
 *
 * Install with Arduino IDE or PlatformIO:
 *   ESP32 Arduino core, ESP32Servo, PubSubClient, ArduinoJson 6.x
 */

#include <WiFi.h>
#include <ESP32Servo.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// -----------------------------------------------------------------------------
// Configuration: edit before flashing
// -----------------------------------------------------------------------------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Use an authenticated TLS broker for a real deployment. HiveMQ is provided as
// a development default so the deployed Railway server and ESP32 can share it.
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_ID = "pillbox-01";

// -----------------------------------------------------------------------------
// Pin definitions and settings
// -----------------------------------------------------------------------------
#define SERVO_PIN 22
#define ULTRASONIC_TRIG 18
#define ULTRASONIC_ECHO 19
#define BUZZER_PIN 4

#define STEPPER_IN1 13
#define STEPPER_IN2 16
#define STEPPER_IN3 14
#define STEPPER_IN4 27

#define SERVO_CLOSED 210
#define SERVO_OPEN 90
#define HAND_DETECTED_CM 8.0f
#define DISPENSE_HOLD_MS 2500UL
#define STEPPER_SPEED_MS 8
#define MQTT_RECONNECT_MS 5000UL
#define WIFI_RECONNECT_MS 15000UL
#define STATUS_INTERVAL_MS 10000UL
#define TELEMETRY_INTERVAL_MS 2000UL

#define BUZZER_FREQ_HIGH 4000
#define BUZZER_FREQ_MID 3000
#define BUZZER_FREQ_LOW 2000

Servo trapdoorServo;
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

float lastDistanceCm = 999.0f;
int currentServoAngle = SERVO_CLOSED;
int currentStepPhase = 0;
const int stepSequence[4][4] = {
  {HIGH, LOW, LOW, LOW},
  {LOW, HIGH, LOW, LOW},
  {LOW, LOW, HIGH, LOW},
  {LOW, LOW, LOW, HIGH}
};

int currentAngleIndex = 0;
const int angleSequence[4] = {45, 135, 225, 315};
const int stepsForAngle[4] = {256, 768, 1280, 1792};

unsigned long lastUltrasonicRead = 0;
unsigned long lastPositionEnforce = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastMqttAttempt = 0;
unsigned long lastStatusPublish = 0;
unsigned long lastTelemetryPublish = 0;
bool handDetectionArmed = true;
String activeMedicationId = "";
int activeQuantity = 1;
String activeCommandId = "";

String topic(const char* suffix) {
  return String("pillbox/") + DEVICE_ID + "/" + suffix;
}

void publishJson(const String& destination, JsonDocument& document, bool retained = false) {
  if (!mqttClient.connected()) return;
  char buffer[1024];
  size_t length = serializeJson(document, buffer, sizeof(buffer));
  mqttClient.publish(destination.c_str(), buffer, retained);
}

void publishStatus(bool online) {
  StaticJsonDocument<256> doc;
  doc["type"] = "status";
  doc["deviceId"] = DEVICE_ID;
  doc["online"] = online;
  doc["lastSeen"] = (uint32_t)(millis() / 1000UL);
  doc["uptime"] = (uint32_t)(millis() / 1000UL);
  doc["wifiRssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  publishJson(topic("status"), doc, true);
}

void publishEvent(const char* eventType, const char* reason = nullptr) {
  StaticJsonDocument<384> doc;
  doc["type"] = eventType;
  doc["deviceId"] = DEVICE_ID;
  doc["angle"] = angleSequence[currentAngleIndex];
  if (activeMedicationId.length() > 0) doc["medicationId"] = activeMedicationId;
  if (activeCommandId.length() > 0) doc["commandId"] = activeCommandId;
  if (reason) doc["reason"] = reason;
  publishJson(topic("event"), doc);
}

void publishDose() {
  StaticJsonDocument<384> doc;
  doc["type"] = "dose";
  doc["deviceId"] = DEVICE_ID;
  doc["confirmed"] = true;
  doc["quantity"] = activeQuantity;
  doc["angle"] = angleSequence[currentAngleIndex];
  doc["eventId"] = String(DEVICE_ID) + "-" + String(millis());
  if (activeMedicationId.length() > 0) doc["medicationId"] = activeMedicationId;
  if (activeCommandId.length() > 0) doc["commandId"] = activeCommandId;
  publishJson(topic("dose"), doc);
}

void publishTelemetry() {
  StaticJsonDocument<512> doc;
  doc["type"] = "telemetry";
  doc["timestamp"] = (uint32_t)(millis() / 1000UL);
  doc["state"] = handDetectionArmed ? "waiting" : "dispensing";
  doc["sensorActive"] = handDetectionArmed;
  doc["ultrasonic"]["distance"] = lastDistanceCm;
  doc["ultrasonic"]["handDetected"] = handDetectionArmed && lastDistanceCm < HAND_DETECTED_CM;
  doc["motors"]["stepper"]["moving"] = false;
  doc["motors"]["stepper"]["position"] = angleSequence[currentAngleIndex];
  doc["motors"]["servo"]["angle"] = currentServoAngle;
  doc["buzzer"]["active"] = false;
  doc["medSlotCount"] = 4;
  publishJson(topic("telemetry"), doc);
}

void lockStepperPosition() {
  digitalWrite(STEPPER_IN1, stepSequence[currentStepPhase][0]);
  digitalWrite(STEPPER_IN2, stepSequence[currentStepPhase][1]);
  digitalWrite(STEPPER_IN3, stepSequence[currentStepPhase][2]);
  digitalWrite(STEPPER_IN4, stepSequence[currentStepPhase][3]);
}

void stepCarousel(int steps, int speedMs) {
  int direction = steps > 0 ? 1 : -1;
  steps = abs(steps);
  for (int i = 0; i < steps; i++) {
    currentStepPhase = (currentStepPhase + direction + 4) % 4;
    lockStepperPosition();
    delay(speedMs);
  }
}

void returnStepperToZero(int stepsToReturn) {
  stepCarousel(-stepsToReturn, STEPPER_SPEED_MS);
  currentStepPhase = 0;
  lockStepperPosition();
  delay(300);
}

void lockServoPosition() {
  trapdoorServo.write(currentServoAngle);
}

void servoOpen() {
  currentServoAngle = SERVO_OPEN;
  trapdoorServo.write(SERVO_OPEN);
}

void servoClose() {
  currentServoAngle = SERVO_CLOSED;
  trapdoorServo.write(SERVO_CLOSED);
}

void buzzerBeep(int frequency, int durationMs) {
  tone(BUZZER_PIN, frequency, durationMs);
  delay(durationMs + 50);
}

void buzzerAlert() {
  buzzerBeep(BUZZER_FREQ_HIGH, 200);
  delay(100);
  buzzerBeep(BUZZER_FREQ_HIGH, 200);
  delay(100);
  buzzerBeep(BUZZER_FREQ_HIGH, 200);
}

void buzzerComplete() {
  buzzerBeep(BUZZER_FREQ_HIGH, 200);
  delay(100);
  buzzerBeep(BUZZER_FREQ_MID, 200);
  delay(100);
  buzzerBeep(BUZZER_FREQ_LOW, 250);
}

float readUltrasonicCm() {
  digitalWrite(ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(ULTRASONIC_TRIG, LOW);
  unsigned long duration = pulseIn(ULTRASONIC_ECHO, HIGH, 30000);
  if (duration == 0) return 999.0f;
  return (duration * 0.034f) / 2.0f;
}

void executeSingleAngleDispense() {
  int angle = angleSequence[currentAngleIndex];
  int stepsNeeded = stepsForAngle[currentAngleIndex];
  handDetectionArmed = false;
  publishEvent("dispensing");

  buzzerAlert();
  delay(300);
  buzzerBeep(BUZZER_FREQ_HIGH, 250);
  delay(150);
  stepCarousel(stepsNeeded, STEPPER_SPEED_MS);
  delay(300);
  servoOpen();
  delay(DISPENSE_HOLD_MS);
  servoClose();
  delay(500);
  returnStepperToZero(stepsNeeded);
  buzzerComplete();
  lockStepperPosition();

  publishDose();
  publishEvent("completed");
  currentAngleIndex = (currentAngleIndex + 1) % 4;
  activeMedicationId = "";
  activeCommandId = "";

  while (readUltrasonicCm() < HAND_DETECTED_CM) delay(100);
  handDetectionArmed = true;
  publishStatus(true);
}

void handleMqttMessage(char* rawTopic, byte* payload, unsigned int length) {
  String receivedTopic(rawTopic);
  if (!receivedTopic.endsWith("/cmd")) return;

  StaticJsonDocument<768> doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.printf("[mqtt] invalid command: %s\n", error.c_str());
    publishEvent("rejected", "invalid JSON command");
    return;
  }

  const char* action = doc["action"].as<const char*>();
  if (!action) action = doc["type"].as<const char*>();
  if (!action || strcmp(action, "dispense") != 0) return;
  if (!handDetectionArmed) {
    publishEvent("rejected", "device busy");
    return;
  }

  activeMedicationId = String(doc["medicationId"] | "");
  activeCommandId = String(doc["commandId"] | "");
  activeQuantity = doc["quantityPerDose"] | 0;
  if (activeQuantity <= 0) activeQuantity = doc["quantity"] | 1;
  if (activeQuantity < 1) activeQuantity = 1;
  if (activeQuantity > 100) activeQuantity = 100;
  executeSingleAngleDispense();
}

void connectWifiIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - lastWifiAttempt < WIFI_RECONNECT_MS) return;
  lastWifiAttempt = now;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqttIfNeeded() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttAttempt < MQTT_RECONNECT_MS) return;
  lastMqttAttempt = now;
  String clientId = String("pillbox-") + DEVICE_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  String statusTopic = topic("status");
  const char* lastWill = "{\"type\":\"status\",\"online\":false}";
  if (mqttClient.connect(clientId.c_str(), statusTopic.c_str(), 0, true, lastWill)) {
    mqttClient.subscribe(topic("cmd").c_str(), 1);
    publishStatus(true);
    StaticJsonDocument<128> request;
    request["type"] = "getSchedule";
    request["deviceId"] = DEVICE_ID;
    publishJson(topic("request"), request);
    publishEvent("online");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(ULTRASONIC_TRIG, OUTPUT);
  pinMode(ULTRASONIC_ECHO, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(STEPPER_IN1, OUTPUT);
  pinMode(STEPPER_IN2, OUTPUT);
  pinMode(STEPPER_IN3, OUTPUT);
  pinMode(STEPPER_IN4, OUTPUT);

  trapdoorServo.attach(SERVO_PIN);
  servoClose();
  lockStepperPosition();
  buzzerBeep(BUZZER_FREQ_LOW, 100);
  delay(150);
  buzzerBeep(BUZZER_FREQ_HIGH, 150);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(handleMqttMessage);
  mqttClient.setBufferSize(2048);
  connectWifiIfNeeded();
}

void loop() {
  unsigned long now = millis();
  connectWifiIfNeeded();
  connectMqttIfNeeded();
  if (mqttClient.connected()) mqttClient.loop();

  if (now - lastUltrasonicRead >= 100) {
    lastUltrasonicRead = now;
    lastDistanceCm = readUltrasonicCm();
    if (handDetectionArmed && lastDistanceCm > 0 && lastDistanceCm < HAND_DETECTED_CM) {
      activeQuantity = 1;
      executeSingleAngleDispense();
    }
  }

  if (now - lastPositionEnforce >= 500) {
    lastPositionEnforce = now;
    lockServoPosition();
    lockStepperPosition();
  }
  if (mqttClient.connected() && now - lastStatusPublish >= STATUS_INTERVAL_MS) {
    lastStatusPublish = now;
    publishStatus(true);
  }
  if (mqttClient.connected() && now - lastTelemetryPublish >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryPublish = now;
    publishTelemetry();
  }
}
