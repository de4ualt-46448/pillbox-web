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
│  │  (Express)   │      │  (SQLite)    │      │              │     │
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
React client) plus **one PostgreSQL database**. MQTT runs over the public HiveMQ
broker so the deployed server and the ESP32 work together from **any network**
(not just localhost/LAN).

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
| `MQTT_BROKER_URL` | `mqtt://broker.hivemq.com:1883` |
| `NODE_ENV` | `production` |

Optional: `CLIENT_ORIGIN`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (for web
push), and any AI API keys (`ELEVENLABS_API_KEY`, `NVIDIA_API_KEY`, etc.).

### 3. Deploy

Railway runs `railway.json` automatically:

- **Build** — installs deps, builds the client (`vite build` → `client/dist`),
  runs `prisma generate`.
- **Start** — applies the schema (`prisma db push`) then boots the server via
  `tsx`. Health is checked on `/api/health`.

The server serves the client at its root URL, so the web app is available at
the Railway-generated domain once the deploy turns green.

### 4. Point the ESP32 at the same broker

So the board can reach the deployed server from any network, set the firmware's
MQTT broker host to `broker.hivemq.com` (port `1883`). The board and the server
then share the same public broker and exchange messages over the internet.

> The `hardware-bridge` workspace is **not** deployed — it's a local LAN helper
> for development only.

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
| `pillbox/{id}/status` | ESP32 → Web | Device online status |
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
