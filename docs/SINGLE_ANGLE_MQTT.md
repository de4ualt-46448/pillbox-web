# Single-Angle MQTT Firmware

The uploaded single-angle ESP32 sketch is available as a separate PlatformIO project under `esp32/firmware-single-angle/`. It preserves the original `45° → 135° → 225° → 315°` carousel sequence and adds Wi-Fi, MQTT commands, status, telemetry, lifecycle events, and confirmed dose events.

## Configure and flash

Edit the Wi-Fi credentials near the top of `esp32/firmware-single-angle/firmware.ino`. The development defaults use the public HiveMQ MQTT endpoint:

```cpp
const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_ID = "pillbox-01";
```

The `DEVICE_ID` must remain `pillbox-01` unless the web app and server are changed to use the same device identifier. For a real medication device, replace the public broker with an authenticated TLS broker and use a TLS-capable client configuration.

Build and upload the variant from its own directory:

```bash
cd esp32/firmware-single-angle
pio run -t upload
pio device monitor -b 115200
```

Arduino IDE users can open `firmware.ino` and install `ESP32Servo`, `PubSubClient`, and `ArduinoJson` 6.x.

## MQTT behavior

The browser and server publish commands to `pillbox/pillbox-01/cmd`. A command such as the following begins the next single-angle dispense immediately:

```json
{
  "action": "dispense",
  "medicationId": "<website-medication-id>",
  "quantityPerDose": 1,
  "commandId": "test-001"
}
```

After the mechanical sequence completes, the firmware publishes one confirmed dose event to `pillbox/pillbox-01/dose`. The server uses the `medicationId`, `quantity`, and optional `commandId` to record the dose and decrement stock exactly once. Status is retained so newly connected browser clients can see the last device state, while telemetry and lifecycle events are published for live diagnostics.

The physical hand sensor also remains active. A hand within 8 cm starts a dose without a medication identifier, so that physical mode is intended for bench testing unless the hardware is paired with a schedule-aware command first. The website's **Hardware → Test the dispenser** control sends a medication-aware command.

## Deployment alignment

For the deployed Railway service, set the server's `MQTT_BROKER_URL` to the same broker host and set the client build variable `VITE_MQTT_WS_URL` to the broker's WebSocket endpoint, for example:

```text
MQTT_BROKER_URL=mqtt://broker.hivemq.com:1883
VITE_MQTT_WS_URL=wss://broker.hivemq.com:8884/mqtt
```

The current server also supports a built-in aedes broker for local development when `MQTT_BROKER_URL` is empty. The embedded broker listens on TCP `1883` and WebSocket `8888` on the development machine; it is not a suitable public broker for a Railway-hosted ESP32.
