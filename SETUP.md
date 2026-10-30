# ============================================================================
# Pillbox — what to download / install on a FRESH laptop (no programs yet)
# ----------------------------------------------------------------------------
# This is a Node.js project (NOT Python), so there is no pip. You only need
# to install the items below, then run the npm commands at the bottom.
# Everything else (database, OCR, text-to-speech) runs locally once the
# code is installed — no extra services required.
# ============================================================================

# ----------------------------------------------------------------------------
# 1) REQUIRED — the one big download
# ----------------------------------------------------------------------------
Node.js  (v18.18 LTS or newer; v20/v22 recommended)
  - Includes npm (the package manager this project uses).
  - Download: https://nodejs.org  (pick the "LTS" Windows Installer .msi)
  - During install, leave "Add to PATH" CHECKED (default).
  - Verify after install (open a NEW terminal):
        node -v      -> prints e.g. v20.11.0
        npm -v       -> prints e.g. 10.2.4

# ----------------------------------------------------------------------------
# 2) OPTIONAL but recommended
# ----------------------------------------------------------------------------
Git            - only if you want to `git clone` the repo instead of copying
                the folder with a USB stick. https://git-scm.com
Visual Studio Code - editor for reading/editing code. https://code.visualstudio.com
                (Not needed to RUN the app.)

# ----------------------------------------------------------------------------
# 3) OPTIONAL — only for the physical ESP32 "Z Care" pillbox (hardware)
# ----------------------------------------------------------------------------
Arduino IDE  (v2) OR PlatformIO  - to flash esp32/firmware/firmware.ino
                Arduino: https://www.arduino.cc  + install "ESP32" board package
                PlatformIO: https://platformio.org
Hardware bridge itself runs on Node.js (already covered by #1).

# ----------------------------------------------------------------------------
# 4) OPTIONAL — only for "clone my voice" reminders
# ----------------------------------------------------------------------------
ElevenLabs API key (free tier) - https://elevenlabs.io
  - Leave blank to skip; the app still works with the built-in on-device voice.
  - Put it in server/.env as:  ELEVENLABS_API_KEY="your-key"

# ----------------------------------------------------------------------------
# 5) Browser (already on the laptop: Edge or Chrome)
# ----------------------------------------------------------------------------
Use Chrome or Edge for the web app — the camera scanner (Tesseract.js OCR)
and voice playback (Web Speech API) need a modern browser with webcam access.

# ============================================================================
# RUN IT (after the downloads above)
# ============================================================================
# Open a terminal IN this project folder (C:\Users\Admin\projects\pillbox-web)
# and run, in order:

# 1. Install all project dependencies (one time, ~1-2 min, needs internet)
npm install

# 2. Prepare the local database (SQLite — no external DB server needed)
npm run prisma:generate
npm run prisma:migrate

# 3. Start the backend server (keep this terminal open)
npm run dev:server
#    -> listens on http://localhost:4000

# 4. In a SECOND terminal, start the frontend (keep it open too)
npm run dev:client
#    -> opens on http://localhost:5173

# 5. Open http://localhost:5173 in Chrome/Edge, sign up, and add a medication.

# ===========================================================================
# MAKE IT PUBLIC (accessible from any device, anywhere on the internet)
# ===========================================================================
# "localhost" only means the laptop itself. To reach the app from a phone or
# another PC over the internet, the easiest NO-INFRA way is a free
# Cloudflare Tunnel (no credit card, no domain needed):
#
#   1. Install:   winget install Cloudflare.Cloudflared
#   2. Login:     cloudflared tunnel login        (one-time, browser)
#   3. Tunnel:    cloudflared tunnel --url http://localhost:4000
#   4. Open the https://xxxx.trycloudflare.com URL it prints.
#
# OR just double-click  go-public.bat  in this folder — it installs deps,
# builds the app, starts the backend, and starts the tunnel for you.
#
# Why port 4000 (not 5173)? The backend serves BOTH the app and the
# API on :4000, so there is a single origin (simplest + works over HTTPS).
# The tunnel also gives HTTPS, which browsers REQUIRE for the webcam,
# microphone, and Web Speech voice playback.
#
# CORS: leave CLIENT_ORIGIN blank in server/.env (already the default)
# so the server reflects the incoming origin — no editing needed.

# ===========================================================================
# ESP32 "Z CARE" HARDWARE
# ===========================================================================
# The physical pillbox talks to the laptop over your LOCAL Wi-Fi, not the
# public internet, so the bridge + ESP32 must be on the same LAN as the
# laptop. The browser can be anywhere (see tunnel above).
#
# Chain:   Browser -> Server (:4000) -> hardware-bridge (laptop) -> ESP32 (TCP)
#
# Setup:
#   A) Flash esp32/firmware/firmware.ino  (Arduino IDE / PlatformIO):
#        - set WIFI_SSID / WIFI_PASSWORD to your Wi-Fi
#        - set BRIDGE_HOST to the LAPTOP's LAN IP (e.g. 192.168.1.42)
#          ...the machine running the bridge, NOT the server URL
#        - adjust GPIO pins in CONFIG if your board differs
#   B) Run the bridge on the laptop (same LAN as the ESP32):
#        set BOX_HOST to the ESP32's IP, then:  npm run dev:bridge
#        (default SERVER_URL is ws://localhost:4000/ws/hardware?role=bridge)
#   C) In the app, open "Hardware" (top-right) -> "Send dispense -> board"
#      to actuate a slot; the IR break-beam reports the drop back and
#      decrements stock automatically.
#
# Notes:
#   - The ESP32 never connects to the public server directly; only the
#     bridge does (over localhost:4000). So "public" does not change
#     the hardware wiring.
#   - Cloned-voice audio is streamed to the board over the bridge's
#     audio TCP socket (set ELEVENLABS_API_KEY in server/.env to enable).

