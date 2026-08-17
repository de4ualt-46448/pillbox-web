# Z Care MQTT Payload Schema

## Purpose and safety contract

All topics follow `pillbox/{deviceId}/{topic}`. The current firmware profile uses a servo trapdoor and an HC-SR04 ultrasonic hand sensor. The hand sensor is **inactive while idle**, becomes active only during a scheduled medication window, and is disabled immediately after the configured dosage sequence completes. A stable hand reading at **5.0 cm or less** is the trigger for scheduled dispensing.

The website/database is authoritative for medication identity, schedule time, dosage label, and `quantityPerDose`. The ESP32 stores a bounded schedule cache so it can continue safely through a short server disconnect. The public HiveMQ broker is for functional testing only; production devices should use authenticated TLS MQTT with per-device ACLs.

Default device ID: `pillbox-01`.

---

## Command topic: `pillbox/{deviceId}/cmd`

Commands are sent by the server to the ESP32. Physical-action commands use QoS 1. The schedule payload may be retained so a reconnecting device can recover its schedule, but clients must never retain a direct dispense command.

### Schedule synchronization

```json
{
  "action": "schedule",
  "scheduleVersion": "1730000000000:2",
  "timezone": "UTC",
  "meds": [
    {
      "medicationId": "abc123",
      "name": "Aspirin",
      "dosage": "100 mg",
      "timesOfDay": ["08:00", "20:00"],
      "quantityPerDose": 1,
      "slot": 0
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `action` | string | Must be `schedule`. |
| `scheduleVersion` | string | Version derived from the website medication updates. |
| `timezone` | string | Schedule timezone metadata. The firmware must be flashed/configured with a matching timezone. |
| `meds` | array | Website-authoritative medication schedule. |
| `meds[].medicationId` | string | Database medication ID. |
| `meds[].name` | string | Display name for diagnostics. |
| `meds[].dosage` | string | Dosage label for diagnostics and logs. |
| `meds[].timesOfDay` | string[] | Local `HH:mm` times at which the hand-sensor window begins. |
| `meds[].quantityPerDose` | number | Number of dose units to dispense. The firmware validates and bounds this value. |
| `meds[].slot` | number | Logical slot/index. The current servo profile does not provide carousel positioning. |

When the ESP32 receives a schedule, it stores it in non-volatile memory and reports `schedule_synced` on the event topic.

### Manual dispense override

```json
{
  "action": "dispense",
  "medicationId": "abc123",
  "quantityPerDose": 1,
  "commandId": "admin-command-123"
}
```

This is an explicit admin/test override and starts dispensing immediately. Scheduled doses do **not** use this path; they wait for the scheduled pill time and a stable hand reading at or below 5 cm.

### Manual pill-time test

```json
{
  "action": "pill_time",
  "medicationId": "abc123",
  "occurrenceId": "test-2026-08-17-08:00-abc123"
}
```

This starts the active reminder and sensor window for a medication already present in the synchronized schedule. It is useful for physical acceptance testing.

### Servo and buzzer diagnostics

```json
{ "action": "servo", "position": 90 }
```

```json
{ "action": "buzzer", "pattern": "alarm", "duration": 3000 }
```

Servo positions and buzzer patterns are hardware diagnostics. They should not be used by an untrusted browser client.

---

## Request topic: `pillbox/{deviceId}/request`

The ESP32 publishes a request after boot and MQTT reconnect:

```json
{
  "type": "getSchedule",
  "deviceId": "pillbox-01",
  "scheduleVersion": "1730000000000:2"
}
```

The server responds on the device command topic with the current schedule. The request is safe to repeat.

---

## Dose topic: `pillbox/{deviceId}/dose`

The ESP32 publishes exactly one confirmed dose event after the dosage sequence completes. Crucially, the sensor is already disabled when this event is published.

```json
{
  "type": "dose",
  "deviceId": "pillbox-01",
  "medicationId": "abc123",
  "quantity": 1,
  "occurrenceId": "2026-08-17-08:00-abc123",
  "commandId": "pillbox-01-123456-1",
  "confirmed": true,
  "sensorActive": false
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Must be `dose`. |
| `deviceId` | string | Reporting device. |
| `medicationId` | string | Database medication ID. |
| `quantity` | number | Quantity completed by the firmware. |
| `occurrenceId` | string | Stable date/time/medication key for scheduled duplicate protection. |
| `commandId` | string | Device command/operation identifier. |
| `confirmed` | boolean | Must be true for stock decrement. |
| `sensorActive` | boolean | Must be false after completion. |

The server combines `occurrenceId` and `commandId` into a unique hardware event ID and records the dose only once. Repeated MQTT delivery must not decrement stock twice.

---

## Event topic: `pillbox/{deviceId}/event`

The ESP32 publishes lifecycle events for dashboard diagnostics:

```json
{
  "type": "pill_time | dispensing | completed | missed | rejected | duplicate | schedule_synced",
  "deviceId": "pillbox-01",
  "state": "active_window",
  "medicationId": "abc123",
  "occurrenceId": "2026-08-17-08:00-abc123",
  "commandId": "pillbox-01-123456-1",
  "quantity": 1,
  "quantityDispensed": 0,
  "sensorActive": true
}
```

For `completed`, `sensorActive` is false. For `missed`, no dose is published and website stock must not be decremented.

---

## Status topic: `pillbox/{deviceId}/status`

Status is published retained and periodically:

```json
{
  "type": "status",
  "online": true,
  "deviceId": "pillbox-01",
  "firmware": "zcare-scheduled-5cm-1",
  "state": "idle",
  "sensorActive": false,
  "scheduleVersion": "1730000000000:2",
  "uptime": 3600,
  "freeHeap": 120000,
  "wifiRssi": -45,
  "ip": "192.168.1.100"
}
```

The MQTT last-will status is `online:false` if the device disconnects unexpectedly.

---

## Telemetry topic: `pillbox/{deviceId}/telemetry`

Telemetry is published approximately every 2 seconds. The distance field is meaningful for hand detection only while `sensorActive` is true.

```json
{
  "type": "telemetry",
  "timestamp": 1234567890,
  "state": "active_window",
  "sensorActive": true,
  "ultrasonic": {
    "distance": 4.8,
    "handDetected": true
  },
  "motors": {
    "stepper": { "moving": false, "position": 0 },
    "servo": { "angle": 90 }
  },
  "buzzer": { "active": true },
  "medSlotCount": 1,
  "activeMedicationId": "abc123",
  "activeQuantity": 1,
  "quantityDispensed": 0
}
```

---

## Topic summary

| Topic | Direction | QoS | Retained | Purpose |
|---|---|---:|---:|---|
| `pillbox/{id}/cmd` | Server → ESP32 | 1 | Schedule only | Schedule and controlled commands |
| `pillbox/{id}/request` | ESP32 → Server | 1 | No | Schedule synchronization request |
| `pillbox/{id}/dose` | ESP32 → Server | 1 | No | One confirmed completed dosage event |
| `pillbox/{id}/event` | ESP32 → Server/browser | 0 | No | State and safety diagnostics |
| `pillbox/{id}/status` | ESP32 → Server/browser | 0 | Yes | Online state and device metadata |
| `pillbox/{id}/telemetry` | ESP32 → Server/browser | 0 | No | Sensor and actuator telemetry |
