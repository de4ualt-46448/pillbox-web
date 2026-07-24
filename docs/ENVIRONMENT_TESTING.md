# Z Care Environment & Testing Guide

## Environment Variables

### Server (.env)

```bash
# Server Configuration
PORT=4000
HOST=0.0.0.0
CLIENT_ORIGIN=http://localhost:5173

# Authentication
JWT_SECRET=your-super-secret-jwt-key-here
JWT_REFRESH_SECRET=your-refresh-secret-key-here

# Database
DATABASE_URL=file:./dev.db

# MQTT Configuration
# Option 1: External broker (HiveMQ, Mosquitto, etc.)
MQTT_BROKER_URL=mqtt://broker.hivemq.com:1883
# Option 2: Local development (leave empty to use built-in aedes broker)
# MQTT_BROKER_URL=

# Voice Services (optional)
ELEVENLABS_API_KEY=
GROQ_API_KEY=
GEMINI_API_KEY=

# Vision/AI Services (optional)
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_OCR_MODEL=meta/llama-3.2-90b-vision-instruct
```

### Client (.env or vite.config.ts)

```bash
# MQTT WebSocket URL (for browser connection)
# HiveMQ public broker:
VITE_MQTT_WS_URL=ws://broker.hivemq.com:8083/mqtt

# Local dev (when server runs its own aedes broker):
# VITE_MQTT_WS_URL=ws://localhost:8888
```

### ESP32 Firmware (edit in zcare_pillbox.ino)

```cpp
// WiFi credentials
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// MQTT broker
const char* MQTT_HOST = "broker.hivemq.com";  // or your MQTT_BROKER_URL
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "";  // leave empty if no auth
const char* MQTT_PASS = "";  // leave empty if no auth
const char* DEVICE_ID = "pillbox-01";
```

---

## Hardware Setup

### ESP32 Pin Connections

| Component | ESP32 Pin | Wire Color (suggested) |
|-----------|-----------|------------------------|
| Stepper IN1 | GPIO 19 | Orange |
| Stepper IN2 | GPIO 22 | Yellow |
| Stepper IN3 | GPIO 21 | Green |
| Stepper IN4 | GPIO 23 | Blue |
| Servo Signal | GPIO 13 | White |
| Ultrasonic Trig | GPIO 5 | Purple |
| Ultrasonic Echo | GPIO 18 | Gray |
| Buzzer (MOSFET Gate) | GPIO 4 | Red |
| 5V Power | VIN/5V | Red |
| GND | GND | Black |

### Required Libraries (Arduino IDE)

Install via Arduino Library Manager (Sketch → Include Library → Manage Libraries):

1. **PubSubClient** by Nick O'Leary (v2.8+)
2. **ArduinoJson** by Benoit Blanchon (v6.21+)
3. **ESP32Servo** by Kevin Harrington (v1.1+)
4. **WiFi** (built-in ESP32 package)

### PlatformIO Alternative

```ini
; platformio.ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
monitor_speed = 115200
lib_deps =
    knolleary/PubSubClient@^2.8
    bblanchon/ArduinoJson@^6.21
    madhephaestus/ESP32Servo@^1.1
```

---

## Testing Guide

### 1. Local Development (No Hardware)

#### Start the Server

```bash
cd server
npm install
npm run dev
```

This starts:
- HTTP server on http://localhost:4000
- Local MQTT broker on TCP 1883
- WebSocket MQTT bridge on ws://localhost:8888

#### Start the Client

```bash
cd client
npm install
npm run dev
```

Opens http://localhost:5173

#### Test with Simulated Pillbox

1. Open the web app
2. Click "Hardware" in the navigation
3. Click "Connect simulated pillbox"
4. Select a medication and click "Simulate pill taken"

### 2. Testing with MQTT Explorer

#### Setup MQTT Explorer

1. Download [MQTT Explorer](http://mqtt-explorer.com/)
2. Create a new connection:
   - **Host:** broker.hivemq.com (or your broker)
   - **Port:** 1883
   - **Websocket Port:** 8883 (if using WebSocket)

#### Test Commands

**Subscribe to all pillbox topics:**
```
pillbox/+/#
```

**Send a dispense command:**
```
Topic: pillbox/pillbox-01/cmd
Payload: {"action":"dispense","medicationId":"test-med","slot":0,"steps":512,"quantity":1}
```

**Send a schedule:**
```
Topic: pillbox/pillbox-01/cmd
Payload: {"action":"schedule","meds":[{"medicationId":"med1","name":"Aspirin","slot":0}]}
```

**Trigger buzzer:**
```
Topic: pillbox/pillbox-01/cmd
Payload: {"action":"buzzer","pattern":"beep","duration":500}
```

### 3. Testing with Real ESP32

#### Flash the Firmware

1. Install [Arduino IDE](https://www.arduino.cc/en/software) or [PlatformIO](https://platformio.org/)
2. Open `firmware/esp32/zcare_pillbox.ino`
3. Edit WiFi and MQTT credentials
4. Select board: Tools → Board → ESP32 Arduino → ESP32 Dev Module
5. Select port: Tools → Port → (your COM port)
6. Click Upload

#### Monitor Serial Output

Open Serial Monitor (Tools → Serial Monitor) at 115200 baud:

```
=== Z Care ESP32 Smart Pillbox ===
Device ID: pillbox-01
[wifi] connecting to YOUR_WIFI...
[wifi] connected, IP: 192.168.1.100
[mqtt] connecting to broker.hivemq.com:1883 ... connected
[mqtt] subscribed to pillbox/pillbox-01/cmd
[setup] ready
```

#### Test End-to-End

1. **ESP32 → Server:** Power on ESP32, check server logs for status/telemetry
2. **Web → ESP32:** Click "Dispense" in web UI, check Serial Monitor for command
3. **Sensor Data:** Move hand near ultrasonic sensor, check web UI for telemetry

### 4. Terminal Testing with mosquitto_pub/sub

#### Install Mosquitto

```bash
# Ubuntu/Debian
sudo apt-get install mosquitto-clients

# macOS
brew install mosquitto

# Windows
# Download from https://mosquitto.org/download/
```

#### Subscribe to Topics

```bash
# Subscribe to all pillbox messages
mosquitto_sub -h broker.hivemq.com -t "pillbox/+/#" -v

# Subscribe to telemetry only
mosquitto_sub -h broker.hivemq.com -t "pillbox/pillbox-01/telemetry" -v
```

#### Publish Commands

```bash
# Send dispense command
mosquitto_pub -h broker.hivemq.com \
  -t "pillbox/pillbox-01/cmd" \
  -m '{"action":"dispense","medicationId":"test","slot":0,"steps":512,"quantity":1}'

# Send schedule
mosquitto_pub -h broker.hivemq.com \
  -t "pillbox/pillbox-01/cmd" \
  -m '{"action":"schedule","meds":[{"medicationId":"m1","name":"Test Med","slot":0}]}'

# Trigger alarm
mosquitto_pub -h broker.hivemq.com \
  -t "pillbox/pillbox-01/cmd" \
  -m '{"action":"buzzer","pattern":"alarm","duration":3000}'
```

### 5. Debugging

#### Common Issues

| Symptom | Cause | Solution |
|---------|-------|----------|
| ESP32 won't connect to WiFi | Wrong SSID/password | Check credentials in firmware |
| MQTT connection failed | Broker unreachable | Verify MQTT_HOST and MQTT_PORT |
| No telemetry in web UI | Topic mismatch | Ensure DEVICE_ID matches in firmware and web |
| Servo not moving | Insufficient power | Use external 5V power for servo |
| Stepper not rotating | Wrong pin order | Check IN1-IN4 wiring matches firmware |
| Buzzer silent | MOSFET not triggered | Verify GPIO 4 → MOSFET gate connection |

#### Serial Debug Output

Enable verbose logging in firmware by changing:

```cpp
#define DEBUG_SERIAL 1

#if DEBUG_SERIAL
  #define DBG(fmt, ...) Serial.printf(fmt, ##__VA_ARGS__)
#else
  #define DBG(fmt, ...)
#endif
```

#### MQTT Debug

Enable MQTT debug in server by setting:

```bash
DEBUG=mqtt*
```

---

## MQTT Broker Options

### Option 1: HiveMQ Public Broker (Recommended for Testing)

- **TCP:** broker.hivemq.com:1883
- **WebSocket:** broker.hivemq.com:8083/mqtt
- **No authentication required**
- **Limitations:** Not for production (public, no persistence)

### Option 2: Mosquitto (Local Development)

```bash
# Install
sudo apt-get install mosquitto

# Start
mosquitto -v

# Default ports: 1883 (TCP), 9001 (WebSocket)
```

### Option 3: Cloud MQTT Services

- [HiveMQ Cloud](https://www.hivemq.com/cloud/) - Free tier available
- [AWS IoT Core](https://aws.amazon.com/iot-core/) - Enterprise
- [Google Cloud IoT](https://cloud.google.com/iot) - Enterprise
- [EMQX Cloud](https://www.emqx.com/cloud) - Free tier available

### Option 4: Built-in Aedes Broker (Development Only)

The server includes a built-in MQTT broker for local development:

```bash
# Just set MQTT_BROKER_URL empty or don't set it
MQTT_BROKER_URL=
```

This starts:
- TCP broker on port 1883
- WebSocket bridge on port 8888

**Note:** Not recommended for production. Use an external broker for reliability.
