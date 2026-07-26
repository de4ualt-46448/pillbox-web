# Pillbox-Web Session Log

## Goal
Scan the entire pillbox-web project, fix all errors, verify recording + OCR + MQTT + ESP32 firmware compatibility, and enhance where needed.

## Bugs Fixed (12 total)

1. **Missing `cookie-parser` middleware** — `server/src/index.ts` — Refresh token cookies were never parsed, making refresh tokens non-functional. Added import + middleware registration + `cookie-parser` dependency.

2. **Wrong secret for refresh token verification** — `server/src/auth.ts` + `server/src/routes/auth.ts` — Refresh endpoint used `verifyToken()` (JWT_SECRET) instead of a dedicated `verifyRefreshToken()` (JWT_REFRESH_SECRET). Added new function.

3. **Hardcoded NVIDIA API key** — `server/test-vision.mjs` — Replaced with `process.env.NVIDIA_API_KEY`.

4. **Hardcoded WiFi credentials** — Both firmware files — Replaced `WE_3D2278`/`233d2278` with `YOUR_WIFI_SSID`/`YOUR_WIFI_PASSWORD` placeholders.

5. **Hardcoded medicationId in `publishDose()`** — `esp32/firmware/firmware.ino` — ESP32 sent `"hand-triggered"` regardless of command. Now stores and sends back the real `medicationId` from the dispense command.

6. **Unimplemented `unsubscribeFromPush()`** — `client/src/screens/Inventory.tsx` — `togglePush` had a TODO comment. Added actual unsubscribe call.

7. **Race condition in `hardwareWs.ts`** — `server/src/hardwareWs.ts` — `bridgeUserId` was overwritten by any web client sending `refreshSchedule`. Added guard: `if (bridgeUserId && bridgeUserId !== ws.userId) return`.

8. **Duplicate MQTT client connections** — `client/src/lib/mqttClient.ts` + `client/src/components/HardwarePanel.tsx` — `connect()` called from both Layout and HardwarePanel. Added `connecting` flag, removed redundant call from HardwarePanel.

9. **MQTT reconnection race** — `server/src/mqttBroker.ts` — Manual reconnect in `close` handler raced with mqtt.js default auto-reconnect. Set `reconnectPeriod: 0`.

10. **Unbounded `firedToday` Set** — `client/src/hooks/useReminders.ts` — Set grew without pruning. Added daily cleanup of stale keys.

11. **Wrong import type** — `client/src/components/MedicationCard.tsx` — Used value import instead of type import for `Medication`.

12. **Unused `filled` prop** — `client/src/screens/MedicationDetail.tsx` — `StepperButton` had unused prop. Removed dead prop + branch.

## Investigation Results

### MQTT WebSocket embedding in HTTP server — FAILED
Attempted to embed MQTT WebSocket on `/mqtt` path of the main HTTP server (port 4000). Failed because `ws` library's `WebSocketServer` with `{server}` intercepts ALL upgrade events and sends HTTP 400 for unmatching paths before our handler can process them. Reverted to standalone port 8888.

### Verdict: Keep MQTT WebSocket on standalone port 8888

## Key Architecture Decisions

- Keep MQTT WebSocket on standalone port 8888 (not embedded in main HTTP server)
- Preserve aedes fallback port 8888 + external broker dual-mode (selected via `MQTT_BROKER_URL` env var)
- Use `connecting` flag on client-side `MqttHardwareClient` instead of checking `client.connected` to prevent duplicate connections
- Two ESP32 firmware directories exist: `esp32/firmware/firmware.ino` (MQTT, current) and `firmware/esp32/zcare_pillbox/zcare_pillbox.ino` (TCP + hardware-bridge, legacy)

## Last Session Fix

### ESP32 online status not showing on website
- `HardwarePanel.tsx` never set `boxSeen = true` from status messages — only from dose events or API polling
- Fix: `onStatus` handler now calls `setBoxSeen(true)` when `online` is true
- Fix: When panel mounts, checks `hardwareClient.getLatestStatus()` to immediately reflect existing status

## Verification Status (all passing)
- ✅ Client build (`tsc --noEmit && vite build`) — 614KB JS bundle
- ✅ Server type-checks (`tsc --noEmit`)
- ✅ Scanner (`node scan-project.js`) — "No issues detected"
- ✅ MQTT broker (port 8888) — pub/sub verified end-to-end
- ✅ Health endpoint — `GET /api/health` → `{"ok":true}`
- ✅ ESP32 MQTT simulation — connect, subscribe, publish all succeed

## Relevant Files Modified

| File | Fix |
|------|-----|
| `server/src/index.ts` | Added cookie-parser |
| `server/src/auth.ts` | Added `verifyRefreshToken()` |
| `server/src/routes/auth.ts` | Use `verifyRefreshToken()` for refresh |
| `server/src/mqttBroker.ts` | `reconnectPeriod: 0` |
| `server/src/hardwareWs.ts` | Bridge ownership guard |
| `server/package.json` | Added `cookie-parser` |
| `client/src/lib/mqttClient.ts` | `connecting` flag guard |
| `client/src/components/HardwarePanel.tsx` | Removed redundant connect, `setBoxSeen(true)` on status |
| `client/src/components/Layout.tsx` | (unchanged — single connect source) |
| `client/src/screens/Inventory.tsx` | Push unsubscribe |
| `client/src/hooks/useReminders.ts` | FiredToday Set pruning |
| `client/src/components/MedicationCard.tsx` | Type import fix |
| `client/src/screens/MedicationDetail.tsx` | Removed unused `filled` prop |
| `client/vite.config.ts` | Removed `/mqtt` proxy (not needed) |
| `esp32/firmware/firmware.ino` | WiFi placeholders, real medicationId |
| `firmware/esp32/zcare_pillbox/zcare_pillbox.ino` | WiFi placeholders |
| `server/test-vision.mjs` | Env var for API key |
| `scan-project.js` | Rewritten with real checks |

## How to Run

```powershell
# Terminal 1 — Server
cd server
npx tsx src/index.ts

# Terminal 2 — Client
cd client
npm run dev
```

Open http://localhost:5173 in browser. Click "Hardware" in the top-right. The "App relay" indicator should show green (connected to MQTT broker). If the ESP32 is on the network and publishing status, the "Pillbox board" indicator will also show green.
