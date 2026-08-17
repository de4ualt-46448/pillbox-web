# Z Care — ESP32 Scheduled Pillbox Firmware

This firmware connects the physical Z Care pillbox directly to the website/server through MQTT. It targets the currently active hardware profile: an ESP32, a servo trapdoor, an HC-SR04 ultrasonic hand sensor, and an active buzzer.

## Exact operating workflow

The device keeps the ultrasonic sensor **off while idle**. It receives the medication schedule from the website and stores a bounded copy in ESP32 non-volatile memory. At a matching scheduled `HH:mm` pill time, the device starts the reminder and activates the sensor. When a hand is stably detected at **5 cm or closer**, the firmware begins the dispense sequence using the website’s `quantityPerDose` value.

After the configured dosage sequence completes, the firmware immediately disables hand-sensor sampling, stops the reminder, publishes one confirmed dose event, and enters cooldown/idle. The same scheduled occurrence cannot trigger twice after MQTT redelivery or a reboot because the device persists recent occurrence IDs.

If no hand is detected before the active window expires, the device disables the sensor, publishes a missed-dose event, and does not publish a confirmed dose. A manual dispense command remains available as an explicit admin/test override; it bypasses the scheduled hand trigger and should not be exposed to untrusted users.

> The current servo profile assumes one servo release cycle equals one dose unit. Without a pill-drop sensor, the firmware cannot prove that a pill physically exited or that a patient swallowed it. Validate the mechanism with the actual hardware before relying on it for medication safety.

## Wiring for the active firmware

| Function | ESP32 pin | Notes |
|---|---:|---|
| Servo signal | GPIO 23 | Use an external 5 V supply for the servo where required; share ground with ESP32. |
| HC-SR04 TRIG | GPIO 18 | 10 µs trigger pulse. |
| HC-SR04 ECHO | GPIO 19 | **Use a voltage divider** because a typical HC-SR04 echo is 5 V and ESP32 GPIO is 3.3 V. |
| Active buzzer control | GPIO 4 | Drive through a transistor/MOSFET for a high-current buzzer. |

The old stepper/IR-break-beam/I2S wiring description does not match `esp32/firmware/firmware.ino` and should not be used for this firmware version.

## Required libraries

Install these libraries in Arduino IDE or PlatformIO:

- **WiFi** — included with the ESP32 Arduino core.
- **WebServer** — included with the ESP32 Arduino core.
- **ESP32Servo** — servo control.
- **PubSubClient** — MQTT TCP client.
- **ArduinoJson** version 6 or later — schedule and event payloads.
- **Preferences** — included with the ESP32 Arduino core for non-volatile storage.

Select an ESP32 board package that supports `WiFi.h`, `WebServer.h`, and `Preferences.h`.

## Configuration before flashing

Edit the configuration values near the top of `firmware.ino`:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* TIMEZONE_INFO = "UTC0";
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_ID = "pillbox-01";
```

The `DEVICE_ID` must match the device ID configured in the website/server. The timezone must match the website medication schedule. For a real deployment, replace the public HiveMQ test broker with an authenticated TLS MQTT broker and add per-device topic permissions.

The hand threshold is intentionally set to the requested value:

```cpp
#define HAND_DETECT_CM 5.0f
```

The firmware also requires three stable readings before it triggers, which reduces false activation from ultrasonic noise. The sensor is never sampled in idle or cooldown.

## Flash and test

1. Open `esp32/firmware/firmware.ino` in Arduino IDE.
2. Select the correct ESP32 board and serial port.
3. Install the required libraries.
4. Set Wi-Fi, timezone, MQTT, and device ID values.
5. Upload the sketch.
6. Open Serial Monitor at **115200 baud**.
7. Confirm the log says the device is ready and `sensor OFF until scheduled pill time`.
8. Confirm the server receives the ESP32 schedule request and publishes a schedule payload.
9. At a scheduled test time, verify the sensor becomes active.
10. Place a hand at 5 cm or closer and verify dispensing begins.
11. Confirm that the sensor becomes inactive immediately after the dosage sequence and that the website records one dose.

The local diagnostic page is available at the ESP32’s assigned IP address. Its test button starts a sensor window for the first synchronized medication and is intended only for bench testing.

## MQTT topics

- `pillbox/{deviceId}/cmd`: server-to-device schedule and controlled commands.
- `pillbox/{deviceId}/request`: device schedule requests after boot/reconnect.
- `pillbox/{deviceId}/dose`: one confirmed dose event after completion.
- `pillbox/{deviceId}/event`: pill-time, dispensing, completion, missed, duplicate, and error events.
- `pillbox/{deviceId}/status`: retained online/device state.
- `pillbox/{deviceId}/telemetry`: sensor and actuator telemetry.

See [`docs/MQTT_SCHEMA.md`](../docs/MQTT_SCHEMA.md) for payloads and idempotency rules.

## Physical acceptance checklist

Before using the device with real medication, confirm all of the following with harmless test items:

| Test | Expected result |
|---|---|
| Hand movement while idle | No sensor activation and no dispense |
| Hand farther than 5 cm during active window | No dispense |
| Stable hand at 5 cm or closer during active window | Dispensing starts once |
| Hand remains near the sensor after completion | Sensor stays off; no retrigger |
| Repeated MQTT dose delivery | Website stock decrements once |
| No hand before timeout | Missed event; no stock decrement |
| Wi-Fi/MQTT reconnect | Schedule is requested again; completed occurrence is not dispensed twice |
