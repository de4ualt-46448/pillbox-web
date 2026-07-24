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
- **Database:** SQLite (development), PostgreSQL (production)

## License

MIT
