/*
 * Z Care — ESP32 Pillbox Firmware (MQTT edition)
 * ----------------------------------------------
 * Connects to the local MQTT broker (run by the pillbox server) instead of
 * Firebase or the old TCP bridge. The board is an MQTT client over TCP.
 *
 * Topics (DEVICE_ID = "pillbox-01"):
 *   pillbox/pillbox-01/cmd       web  -> board   {type:"dispense"|"schedule", ...}
 *   pillbox/pillbox-01/request   board-> server  {type:"getSchedule"}   (on boot)
 *   pillbox/pillbox-01/dose      board-> web+svr {type:"dose", medicationId}
 *   pillbox/pillbox-01/status    board-> web     {online:true, lastSeen:<epoch s>}
 *
 * Libraries (Arduino IDE / PlatformIO):
 *   - PubSubClient  (knolleary)  >= 2.8
 *   - Servo (built-in)
 *   - Adafruit GFX + SSD1306
 *   - Adafruit NeoPixel
 *   - NTPClient, ArduinoJson (bundled with PubSubClient)
 *
 * Audio reminders over MQTT are out of scope here; the board alerts with
 * buzzer + NeoPixels. Voice playback would use a separate channel.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Servo.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_NeoPixel.h>
#include <NTPClient.h>
#include <WiFiUdp.h>

// ----------------------------- CONFIG -----------------------------------
#define WIFI_SSID      "WE_3D2278"
#define WIFI_PASSWORD  "233d2278"

// MQTT broker address.
// For HiveMQ public cloud broker (free, no auth needed):
#define BROKER_HOST    "broker.hivemq.com"
#define BROKER_PORT    1883
#define DEVICE_ID      "pillbox-01"

// For local dev (when running your own broker on LAN), use:
// #define BROKER_HOST  "192.168.1.5"
// #define BROKER_PORT  1883

#define SERVO_PIN      13
#define IR_PIN         14
#define BUZZER_PIN     15
#define NEO_PIN        2
#define NUM_PIXELS     8

#define OLED_SDA       21
#define OLED_SCL       22
#define OLED_W         128
#define OLED_H         64

#define DISPENSE_TIMEOUT_MS 20000
#define MAX_MEDS        16
#define MQTT_KEEPALIVE 30
#define HEARTBEAT_MS   5000

// Self-test: when 1, report a drop ~3s after a dispense (no real pill/IR).
#define SELF_TEST 0

// ----------------------------- State ------------------------------------
WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);

Servo carousel;
Adafruit_NeoPixel pixels(NUM_PIXELS, NEO_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_SSD1306 display(OLED_W, OLED_H, &Wire, -1);

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60000);

struct Med {
  String id;
  String name;
  int slot;
};
Med schedule[MAX_MEDS];
int medCount = 0;

String pendingMedId = "";
unsigned long dispenseStart = 0;
bool dispensing = false;
bool alerting = false;
unsigned long lastBuzz = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastReconnect = 0;

String cmdTopic = "pillbox/" + String(DEVICE_ID) + "/cmd";
String doseTopic = "pillbox/" + String(DEVICE_ID) + "/dose";
String statusTopic = "pillbox/" + String(DEVICE_ID) + "/status";
String requestTopic = "pillbox/" + String(DEVICE_ID) + "/request";

// --------------------------- Helpers ------------------------------------
void setLEDs(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < NUM_PIXELS; i++) pixels.setPixelColor(i, pixels.Color(r, g, b));
  pixels.show();
}
void buzz(bool on) { digitalWrite(BUZZER_PIN, on ? HIGH : LOW); }
void showStatus(const char* line1, const char* line2 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Z Care Pillbox");
  display.setTextSize(2);
  display.setCursor(0, 22);
  display.println(line1);
  display.setTextSize(1);
  display.setCursor(0, 48);
  display.println(line2);
  display.display();
}
void openSlot(int slot) {
  int angle = (slot * 180) / max(1, (medCount > 0 ? medCount : 1));
  carousel.write(angle);
  delay(600);
}
void closeAll() { carousel.write(0); }

// --------------------------- MQTT logic ---------------------------------
void publishStatus() {
  StaticJsonDocument<128> doc;
  doc["online"] = true;
  doc["lastSeen"] = (int)timeClient.getEpochTime();
  char buf[128];
  serializeJson(doc, buf);
  mqttClient.publish(statusTopic.c_str(), buf, true);  // retained
}

void publishDose(const String& medId) {
  StaticJsonDocument<128> doc;
  doc["type"] = "dose";
  doc["medicationId"] = medId;
  char buf[128];
  serializeJson(doc, buf);
  mqttClient.publish(doseTopic.c_str(), buf, false);
  Serial.println("dose published");
}

void applySchedule(JsonDocument& doc) {
  medCount = 0;
  JsonArray meds = doc["meds"];
  if (meds.isNull()) return;
  for (JsonVariant v : meds) {
    if (medCount >= MAX_MEDS) break;
    schedule[medCount].id = v["medicationId"] | "";
    schedule[medCount].name = v["name"] | "";
    schedule[medCount].slot = v["slot"] | medCount;
    medCount++;
  }
  showStatus("Synced", (String(medCount) + " meds").c_str());
  Serial.printf("schedule loaded: %d meds\n", medCount);
}

void beginDispense(const String& medId, int slot) {
  pendingMedId = medId;
  dispensing = true;
  alerting = true;
  dispenseStart = millis();
  showStatus("Take med", medId.substring(0, 8).c_str());
  setLEDs(0, 255, 180);
  openSlot(slot);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != cmdTopic) return;

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) { Serial.println("json parse error"); return; }

  const char* type = doc["type"] | "";
  if (strcmp(type, "dispense") == 0) {
    String mid = doc["medicationId"] | "";
    int slot = 0;
    for (int s = 0; s < medCount; s++) if (schedule[s].id == mid) slot = schedule[s].slot;
    beginDispense(mid, slot);
  } else if (strcmp(type, "schedule") == 0) {
    applySchedule(doc);
  }
}

void ensureMqtt() {
  if (mqttClient.connected()) return;
  if (millis() - lastReconnect < 2000) return;
  lastReconnect = millis();

  String clientId = "pillbox-esp32-" + String(DEVICE_ID);
  if (mqttClient.connect(clientId.c_str(), NULL, NULL, statusTopic.c_str(), 1, true, "{\"online\":false}")) {
    mqttClient.subscribe(cmdTopic.c_str());
    // Ask the server for the current schedule.
    mqttClient.publish(requestTopic.c_str(), "{\"type\":\"getSchedule\"}", false);
    publishStatus();
    showStatus("Linked", "mqtt ok");
    Serial.println("MQTT connected");
  } else {
    Serial.print("MQTT connect failed, rc=");
    Serial.println(mqttClient.state());
  }
}

// ----------------------------- Setup ------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(IR_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  buzz(false);
  pixels.begin();
  setLEDs(10, 10, 10);

  carousel.attach(SERVO_PIN);
  closeAll();

  Wire.begin(OLED_SDA, OLED_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  showStatus("Booting", "connect wifi");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");
  timeClient.begin();
  timeClient.update();

  mqttClient.setServer(BROKER_HOST, BROKER_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
  mqttClient.setKeepAlive(MQTT_KEEPALIVE);

  showStatus("Online", WiFi.localIP().toString().c_str());
}

// ------------------------------ Loop ------------------------------------
void loop() {
  timeClient.update();
  ensureMqtt();
  mqttClient.loop();

  unsigned long now = millis();
  if (now - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = now;
    if (mqttClient.connected()) publishStatus();
  }

  if (dispensing) {
    if (alerting && millis() - lastBuzz > 400) {
      buzz(true); setLEDs(255, 120, 0);
      lastBuzz = millis();
    }
    if (alerting && millis() - lastBuzz > 200) {
      buzz(false); setLEDs(0, 255, 180);
    }

#if SELF_TEST
    if (millis() - dispenseStart > 3000) {
      publishDose(pendingMedId);
      showStatus("Dispensed", pendingMedId.substring(0, 8).c_str());
      alerting = false; buzz(false);
      setLEDs(0, 200, 80);
      delay(1500);
      closeAll();
      dispensing = false;
      return;
    }
#endif

    bool dropped = (digitalRead(IR_PIN) == LOW);
    if (dropped) {
      publishDose(pendingMedId);
      showStatus("Dispensed", pendingMedId.substring(0, 8).c_str());
      alerting = false; buzz(false);
      setLEDs(0, 200, 80);
      delay(1500);
      closeAll();
      dispensing = false;
    } else if (millis() - dispenseStart > DISPENSE_TIMEOUT_MS) {
      showStatus("Missed", pendingMedId.substring(0, 8).c_str());
      alerting = false; buzz(false);
      setLEDs(200, 0, 0);
      delay(1500);
      closeAll();
      dispensing = false;
    }
  }

  delay(10);
}
