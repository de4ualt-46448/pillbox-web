# ESP32 Setup — Ready to Flash

## Flash Instructions

1. Open `zcare_pillbox.ino` in Arduino IDE
2. Select board: **ESP32 Dev Module**
3. Select the correct COM port
4. Install required libraries (Sketch > Include Library > Manage Libraries):
   - **PubSubClient** by Nick O'Leary
   - **ArduinoJson** by Benoit Blanchon (>= 6.x)
   - **ESP32Servo** by Kevin Harrington
5. **Edit the firmware** before uploading:
   - Set `WIFI_SSID` and `WIFI_PASS` to your Wi-Fi credentials
   - **Local dev:** keep `#define MQTT_LOCAL` uncommented, set `MQTT_HOST` to your computer's LAN IP (run `ipconfig` / `ifconfig`)
   - **Deployment:** uncomment `#define MQTT_DEPLOY` and comment out `#define MQTT_LOCAL`
6. Click **Upload**

## Verify Connection

Open Serial Monitor at **115200 baud**. You should see:

```
=== Z Care ESP32 Pillbox (MQTT) ===
Mode: LOCAL DEV
MQTT Host: 192.168.1.5:1883
Device ID: pillbox-01
[WiFi] Connected! IP: 192.168.1.xxx
[MQTT] Connecting to 192.168.1.5:1883 ... connected
[MQTT] Subscribed to pillbox/pillbox-01/cmd
```

## Check the Website

1. Open the web app in your browser
2. Go to Hardware panel
3. "App relay (browser → server)" should be green (live)
4. "Pillbox board (ESP32)" should be green (received status/telemetry)

## Troubleshooting

- **WiFi won't connect:** ESP32 only supports 2.4GHz. Make sure your router broadcasts 2.4GHz.
- **MQTT won't connect:** Verify `MQTT_HOST` matches your server's IP (`ipconfig`). Make sure server is running (`npm run dev`).
- **Board connects but website doesn't update:** Check browser console (F12) for `[mqtt] connected to ws://localhost:8888`.
- **Deployment:** Server's `MQTT_BROKER_URL` env var must point to the same broker as the firmware (e.g. `mqtt://broker.hivemq.com:1883`).
