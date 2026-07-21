# Z Care — ESP32 Firmware

Firmware for the physical **Z Care** pillbox that connects to the Pillbox web
app through the local `hardware-bridge`. It receives the medication schedule
and dispense commands over TCP, drives the servo carousel, verifies the drop
with an IR break-beam, and reports dispenses back so stock decrements.

## What it does

1. **Connects** to Wi-Fi, then opens two TCP sockets to the `hardware-bridge`
   host on the LAN:
   - `BRIDGE_PORT` — **audio** (4-byte little-endian length + MP3 bytes)
   - `BRIDGE_PORT + 1` — **control** (newline-delimited JSON)
2. On connect it sends `{"type":"hello"}` and `{"type":"getSchedule"}`.
3. The server pushes `{"type":"schedule", "meds":[...]}` — the board stores the
   list (slot = order in the list).
4. When a dose is due, the web app (or server) sends
   `{"type":"dispense","medicationId":"..."}`. The board:
   - rotates the servo to that slot (opens the compartment),
   - pulses the **buzzer + NeoPixel LEDs** as an alert,
   - plays the streamed **voice reminder** over I2S (if `ENABLE_AUDIO`),
   - watches the **IR break-beam**; when a pill drops it sends
     `{"type":"dose","medicationId":"..."}` (stock decrements on the server),
   - after a timeout with no drop, reports a **missed dose** (alert stays red).

## Wiring (defaults — edit `CONFIG` in `firmware.ino`)

| Function | ESP32 pin |
|---|---|
| Servo (carousel) | GPIO 13 |
| IR break-beam (chute) | GPIO 14 (beam-broken = `LOW`; flip if yours is inverted) |
| Buzzer | GPIO 15 |
| NeoPixel LEDs | GPIO 2 (8 pixels) |
| OLED SSD1306 (I2C) | SDA 21, SCL 22 |
| I2S DAC MAX98357A | BCLK 26, LRC 25, DOUT 33 (audio, optional) |

The IR sensor is read with `INPUT_PULLUP`; a pill dropping interrupts the beam.
Adjust the polarity in `loop()` if your sensor is active-high.

## Libraries

In the Arduino IDE / PlatformIO install:

- **WiFi** (ESP32 built-in)
- **ArduinoJson** (≥ 6)
- **Servo** (built-in)
- **Adafruit GFX** + **Adafruit SSD1306**
- **Adafruit NeoPixel**
- **NTPClient**
- **ESP8266Audio** (earlephilhower) — only needed if `ENABLE_AUDIO 1`

## Configuration

Edit the `CONFIG` block at the top of `firmware.ino`:

```cpp
#define WIFI_SSID      "YOUR_WIFI_SSID"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"
#define BRIDGE_HOST    "192.168.4.10"   // IP of the machine running hardware-bridge
#define BRIDGE_PORT    5000
```

Make sure `BRIDGE_HOST` is reachable from the ESP32 (same Wi-Fi / LAN), and that
the `hardware-bridge` is running and pointed at the ESP32's IP
(`BOX_HOST` / `BOX_PORT` in the bridge's env).

## Build & flash

- **Arduino IDE:** open `firmware/firmware.ino`, pick your ESP32 board + port,
  install the libraries above, set `ENABLE_AUDIO` (0 or 1), and Upload.
- **PlatformIO:** create a project with `framework = arduino`,
  `board = esp32dev`, and the libraries in `platformio.ini`; copy `firmware.ino`
  to `src/main.cpp`.

Open the Serial Monitor (115200 baud) to see connection + sync logs.

## Protocol summary

```
Server → board (CONTROL JSON)
  {"type":"schedule","meds":[{"medicationId","name","dosage","timesOfDay","slot"}]}
  {"type":"dispense","medicationId":"...","text":"..."}

Board → server (CONTROL JSON, newline-terminated)
  {"type":"hello"}
  {"type":"getSchedule"}
  {"type":"dose","medicationId":"..."}     // IR beam confirmed a drop

Audio (separate socket)
  Server → board: 4-byte LE uint32 length + raw MP3 bytes
```

This matches `hardware-bridge/src/index.ts` and `server/src/hardwareWs.ts`.
