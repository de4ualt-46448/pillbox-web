# Z Care Smart Pillbox System

Complete IoT solution connecting ESP32 hardware to a web application via MQTT for real-time medication dispensing and monitoring.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Z Care System                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐     │
│  │   Web App    │      │ MQTT Broker  │      │   ESP32      │     │
│  │   (React)    │◄────►│  (HiveMQ/    │◄────►│   Firmware   │     │
│  │              │  WS  │   Aedes)     │ TCP  │              │     │
│  └──────────────┘      └──────────────┘      └──────────────┘     │
│         │                       │                       │          │
│         ▼                       ▼                       ▼          │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐     │
│  │   Server     │      │  Database    │      │  Hardware    │     │
│  │  (Express)   │      │ (PostgreSQL) │      │              │     │
│  └──────────────┘      └──────────────┘      │ • Stepper    │     │
│                                               │ • Servo      │     │
│                                               │ • Ultrasonic │     │
│                                               │ • Buzzer     │     │
│                                               └──────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Server Setup

```bash
cd server
npm install
cp .env.example .env  # Edit with your settings
npm run prisma:push
npm run dev
```

### 2. Client Setup

```bash
cd client
npm install
cp .env.example .env  # Edit MQTT_WS_URL if needed
npm run dev
```

### 3. ESP32 Firmware

1. Open `firmware/esp32/zcare_pillbox.ino` in Arduino IDE
2. Edit WiFi and MQTT credentials
3. Install required libraries (see docs/ENVIRONMENT_TESTING.md)
4. Upload to ESP32

### 4. Test

1. Open http://localhost:5173
2. Navigate to Hardware panel
3. Connect simulated pillbox or real ESP32
4. Test dispensing and monitoring

## Deploy to Railway

The app deploys as **one Node service** (serving the Express API *and* the built
React client) plus **one PostgreSQL database**. The server and ESP32 use MQTT
TCP, while the browser uses MQTT over secure WebSockets. This lets the deployed
server, website, and ESP32 work together from different networks.

### 1. Create the project

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**.
3. Add a **PostgreSQL** database service to the project
   (**New → Database → PostgreSQL**).

### 2. Set environment variables

On the Node service, go to **Variables** and set (see `.env.example`):

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the Postgres service) |
| `JWT_SECRET` | a long random string (`openssl rand -hex 32`) |
| `JWT_REFRESH_SECRET` | a different long random string |
| `MQTT_BROKER_URL` | `mqtt://broker.hivemq.com:1883` for functional testing |
| `NODE_ENV` | `production` |
| `OCR_PROVIDER` | `auto` (Groq Qwen, then NVIDIA, then OpenAI) or a fixed provider name |
| `GROQ_API_KEY` / `NVIDIA_API_KEY` / `OPENAI_API_KEY` | Configure at least one provider key for medication OCR |

The browser automatically uses `wss://broker.hivemq.com:8884/mqtt` on the
HTTPS deployment unless `VITE_MQTT_WS_URL` overrides it. Optional variables
include `CLIENT_ORIGIN`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (for web
push), and AI API keys such as `ELEVENLABS_API_KEY` or `NVIDIA_API_KEY`. Medication OCR uses a vision-capable provider and returns structured fields with confidence warnings. The scanner preprocesses camera/gallery images, preserves the raw transcription, and always sends the result to an editable review screen before saving. Configure `GROQ_OCR_MODEL` (default `qwen/qwen3.6-27b`), `NVIDIA_OCR_MODEL`, or `OPENAI_OCR_MODEL` only when you need to override the documented defaults. Never commit provider keys to Git; the test utilities require their keys through environment variables.

> The public HiveMQ broker is unauthenticated and shared. It is suitable only
> for testing. For a real pillbox, replace both MQTT URLs with an authenticated
> private broker, enable TLS for the ESP32, and restrict each device to its own
> `pillbox/{deviceId}/...` topics.

### 3. Deploy

Railway runs `railway.json` automatically:

- **Build** — installs dependencies, builds the client (`vite build` →
  `client/dist`), and runs `prisma generate`.
- **Start** — applies the PostgreSQL schema (`prisma db push`) and boots the
  server via `tsx`. Health is checked on `/api/health`.

The server serves the client at its root URL, so the web app is available at
the Railway-generated domain once the deploy turns green.

### 4. Point the ESP32 at the same broker

The firmware now defaults to `MQTT_DEPLOY`, with `broker.hivemq.com` on port
`1883`, matching the server's functional-testing URL. Before flashing, edit
`WIFI_SSID`, `WIFI_PASS`, and `DEVICE_ID`. The board and server must use the
same device ID and topic family.

> The `hardware-bridge` workspace is **not deployed** — it is a local LAN
> helper for development only.

## File Structure

```
pillbox-web/
├── firmware/
│   └── esp32/
│       └── zcare_pillbox.ino          # ESP32 firmware
├── server/
│   ├── src/
│   │   ├── mqttBroker.ts              # MQTT server client
│   │   ├── index.ts                   # Express server
│   │   └── ...
│   └── package.json
├── client/
│   ├── src/
│   │   ├── lib/
│   │   │   └── mqttClient.ts          # Browser MQTT client
│   │   ├── components/
│   │   │   └── HardwarePanel.tsx       # Hardware control UI
│   │   └── ...
│   └── package.json
├── docs/
│   ├── MQTT_SCHEMA.md                 # Payload documentation
│   └── ENVIRONMENT_TESTING.md         # Setup & testing guide
└── README.md
```

## MQTT Topics

| Topic | Direction | Purpose |
|-------|-----------|---------|
| `pillbox/{id}/cmd` | Web → ESP32 | Dispense, schedule, servo, buzzer commands |
| `pillbox/{id}/dose` | ESP32 → Web | Pill dispensed confirmation |
| `pillbox/{id}/status` | ESP32 → Web+Server | Device online status |
| `pillbox/{id}/telemetry` | ESP32 → Web | Sensor data (ultrasonic, motors) |
| `pillbox/{id}/request` | ESP32 → Server | Schedule request |

## Hardware Pinout

| Component | ESP32 Pin |
|-----------|-----------|
| Stepper IN1 | GPIO 19 |
| Stepper IN2 | GPIO 22 |
| Stepper IN3 | GPIO 21 |
| Stepper IN4 | GPIO 23 |
| Servo Signal | GPIO 13 |
| Ultrasonic Trig | GPIO 5 |
| Ultrasonic Echo | GPIO 18 |
| Buzzer (MOSFET) | GPIO 4 |

## Features

- **Real-time dispensing** via MQTT commands
- **Sensor monitoring** (ultrasonic distance, hand detection)
- **Motor control** (stepper carousel, servo trapdoor)
- **Audio alerts** (buzzer patterns)
- **Stock management** (automatic pill count updates)
- **Push notifications** (dose reminders)
- **Simulated mode** (test without hardware)

## Documentation

- [MQTT Payload Schema](docs/MQTT_SCHEMA.md)
- [Environment & Testing Guide](docs/ENVIRONMENT_TESTING.md)

## Tech Stack

- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Backend:** Express, TypeScript, Prisma ORM
- **Hardware:** ESP32, Arduino, PubSubClient
- **Protocol:** MQTT over TCP/WebSocket
- **Database:** PostgreSQL (local dev can use SQLite with a `provider = "sqlite"` schema)

## License

MIT
