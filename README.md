# Pillbox — Web

A **publishable web port** of the Android *Smart Pillbox* app. Built with
**React + TypeScript** (frontend) and **Node + Express + Prisma** (backend),
with user accounts (sign up / sign in) so each person's medications, stock,
and voice profiles are saved to their own account.

> This project mirrors the original Android module (`pillbox-v3-main/pillbox-module`):
> inventory dashboard, medication detail with stock stepper, camera OCR scan
> (Tesseract.js), voice profiles (browser TTS + ElevenLabs cloning), reminders
> (browser notifications + speech), and a hardware bridge to a physical ESP32
> pillbox.

## Features

| Area | What it does |
|---|---|
| **Accounts** | Email + password sign up / sign in (JWT, httpOnly refresh cookie). Data is per-user. |
| **Inventory ("Green Menu")** | Searchable list of medication cards, low-stock banner, gradient "X left" badge, draining stock bar — neumorphic mint/teal theme. |
| **Medication detail** | Hero, dosage, `＋ / −` stock stepper, save. Delete. |
| **Scanner** | Webcam → Tesseract.js OCR → ported `PrescriptionParser` regex → editable review → save. |
| **Voice profiles** | Built-in voice (Web Speech API) or clone your own via ElevenLabs (server-side key). Preview, set default, delete. |
| **Reminders** | Each `timesOfDay` slot fires a browser Notification + spoken reminder; optionally streams to the physical box. |
| **Hardware bridge** | Local agent relays reminder audio + control to a real ESP32 "Z Care" pillbox over TCP: it pushes the medication **schedule**, sends **dispense** commands (servo + alert), streams cloned-voice audio, and receives **dose** events from the board's IR break-beam to decrement stock. See `esp32/`. |

## Tech stack

- **Client:** React 18, TypeScript, Vite, React Router, Tailwind CSS, TanStack Query, Zustand, React Hook Form, react-webcam, tesseract.js.
- **Server:** Node + Express + TypeScript (tsx), Prisma ORM, SQLite (dev) / PostgreSQL (prod), JWT auth, `ws` WebSocket relay, multer uploads.
- **Hardware bridge:** Node + `ws` + `net` (runs on the pillbox LAN).

## Folder structure

```
pillbox-web/
├── client/            React web app (the UI)
├── server/            Express API + auth + DB + ElevenLabs proxy + WS relay
├── hardware-bridge/   ESP32 TCP ↔ server WebSocket relay
├── esp32/             Z Care ESP32 firmware (Arduino) + wiring docs
└── README.md
```

## Prerequisites

- Node.js 18+ (tested on v24)
- npm 9+

## Setup

```bash
# 1. Install all workspaces
npm install

# 2. Configure the server
cp server/.env.example server/.env
#   - set JWT_SECRET to a long random string
#   - (optional) set ELEVENLABS_API_KEY for voice cloning
#   - DATABASE_URL defaults to SQLite (file:./dev.db) — no DB server needed

# 3. Create the database
npm run prisma:generate
npm run prisma:push

# 4. Run everything (server :4000, client :5173, hardware bridge)
npm run dev
```

Open http://localhost:5173, sign up, and start adding medications.

Run pieces individually if you prefer:

```bash
npm run dev:server     # API + WS on :4000
npm run dev:client     # Vite dev server on :5173 (proxies /api and /ws)
npm run dev:bridge     # hardware relay (only needed for a physical pillbox)
```

## Environment variables (`server/.env`)

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | Use a `postgresql://…` URL to publish. |
| `JWT_SECRET` | `dev-insecure-change-me` | **Change before deploying.** |
| `CLIENT_ORIGIN` | `http://localhost:5173` | CORS origin (with credentials). |
| `ELEVENLABS_API_KEY` | _(empty)_ | Enables voice cloning. Keep server-side only. |
| `PORT` | `4000` | API port. |

## Camera & microphone permissions

- **Scanner** needs camera access (grant when prompted).
- **Voice cloning** needs microphone access to record the sample.
- **Reminders** request Notification permission on first load.

## How it maps to the Android app

| Android (`com.pillbox.app`) | Web |
|---|---|
| `data/entity/*`, Room DAOs | Prisma models + REST routes (`server/src/routes`) |
| `ui/inventory/*` | `client/src/screens/Inventory.tsx`, `MedicationCard.tsx` |
| `ui/scanner/*` + `ocr/*` | `client/src/screens/Scanner.tsx` + `lib/prescriptionParser.ts` (Tesseract.js) |
| `voice/*` (ElevenLabs) | `server/src/voice/elevenlabs.ts` + `client/src/lib/tts.ts` |
| `reminder/*` (AlarmManager) | `client/src/hooks/useReminders.ts` (Notification API + Web Speech) |
| `hardware/HardwareAudioStreamer` | `server/src/hardwareWs.ts` + `hardware-bridge/src/index.ts` + `esp32/firmware/firmware.ino` |

## Publishing

1. **Database:** set `DATABASE_URL` to a hosted PostgreSQL (Supabase, Railway, Render, Neon…) and run `npm run prisma:push` against it.
2. **Set `JWT_SECRET`** to a strong random value; keep `ELEVENLABS_API_KEY` server-side.
3. **Deploy the server** (Render/Railway/Fly) and the **client** (Vercel/Netlify/Cloudflare). For the client, set `VITE_API_BASE` if you host the API on a different domain, or keep the Vite proxy only for dev and point `CLIENT_ORIGIN` to your production URL.
4. **Hardware:** run `hardware-bridge` on a machine on the same LAN as the ESP32, pointing `SERVER_URL` at your deployed API's `/ws/hardware?role=bridge`.

### Connecting a real ESP32 (Z Care)

The web app talks to a physical **Z Care** pillbox through a local bridge (browsers
can't open raw TCP). The board receives its schedule, gets dispense commands,
plays the voice reminder, and reports drops via an IR break-beam.

1. **Flash the firmware:** open `esp32/firmware/firmware.ino` in the Arduino IDE
   (or PlatformIO), install the libraries listed in `esp32/README.md`, set your
   Wi-Fi credentials + `BRIDGE_HOST` (the IP of the machine running the bridge),
   and upload to the ESP32. Wire the servo, IR sensor, buzzer, NeoPixels, OLED,
   and (optionally) an I2S DAC per the pin table in `esp32/README.md`.
2. **Run the bridge** on a machine on the same LAN as the ESP32:
   ```bash
   cd hardware-bridge
   BOX_HOST=192.168.x.x BOX_PORT=5000 npm run dev
   ```
   (Point `BOX_HOST` at the ESP32's IP; `SERVER_URL` defaults to the API.)
3. **Run the server + client**, sign in, add medications. The bridge pushes the
   schedule to the board automatically; when a reminder fires (or you tap a med),
   the board dispenses the slot, alerts, and reports the drop so stock decrements.

Protocol details (audio socket = 4-byte LE length + MP3; control socket =
newline JSON) are documented in `esp32/README.md`, `hardware-bridge/src/index.ts`,
and `server/src/hardwareWs.ts`.

## Known limitations vs. Android

- Browsers can't wake a closed tab the way `AlarmManager` does, so reminders only
  fire while the app is open. Add a service worker + Web Push for true background
  delivery.
- The hardware bridge needs a device on the LAN; the browser can't open raw TCP.
- Local preview TTS uses the browser's built-in voices (best-effort), not
  Android's high-quality voices.

### Scanner (real OCR)
The Scanner uses **Tesseract.js** — a genuine on-device OCR engine — for both
bottle-label and prescription scans. The prescription mode auto-detects the
dosage and the `HH:mm` times on the page and carries them into the review so
reminder timers are added automatically. If the webcam is unreliable, use
**Upload photo instead** — it runs the same real OCR on a still image, and the
**Live scan** panel shows the text Tesseract is reading.

### Voice cloning (ElevenLabs)
Cloning is server-side and needs an **ElevenLabs API key with the
`create_instant_voice_clone` permission** (Creator tier or higher; enable it in
your ElevenLabs dashboard). Without it, the app shows a clear error and the
built-in on-device voice still works. Your key lives only in `server/.env` and
is never sent to the browser.

### Hardware without an ESP32
Open **Hardware → Connect simulated pillbox** to exercise the full connector
(schedule push, dispense, dose → stock decrement) over the real WebSocket
protocol with no physical board. The firmware also has a `SELF_TEST` mode
(`esp32/firmware/firmware.ino`) that reports a drop without a real pill/IR
sensor, so you can verify the board → bridge → server chain once you flash it.
