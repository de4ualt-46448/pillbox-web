# Z Care MQTT Payload Schema

## Topic Structure

All topics follow the pattern: `pillbox/{deviceId}/{topic}`

Default device ID: `pillbox-01`

---

## Command Topics (Web/Server → ESP32)

### `pillbox/{deviceId}/cmd`

#### Dispense Command
Triggers the stepper motor to rotate and servo to open/close for pill dispensing.

```json
{
  "action": "dispense",
  "medicationId": "abc123",
  "slot": 0,
  "steps": 512,
  "quantity": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Must be `"dispense"` |
| `medicationId` | string | Database ID of the medication |
| `slot` | number | Carousel slot number (0-7) |
| `steps` | number | Stepper motor steps (2048 = full revolution) |
| `quantity` | number | Number of pills to dispense |

#### Schedule Command
Pushes the medication schedule to the ESP32 for local storage.

```json
{
  "action": "schedule",
  "meds": [
    {
      "medicationId": "abc123",
      "name": "Aspirin",
      "slot": 0
    },
    {
      "medicationId": "def456",
      "name": "Metformin",
      "slot": 1
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Must be `"schedule"` |
| `meds` | array | List of medications to store |
| `meds[].medicationId` | string | Database ID |
| `meds[].name` | string | Display name |
| `meds[].slot` | number | Carousel slot (0-7) |

#### Servo Command
Controls the trapdoor servo motor directly.

```json
{
  "action": "servo",
  "position": 90
}
```

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Must be `"servo"` |
| `position` | number | Servo angle (0-180 degrees) |

#### Buzzer Command
Controls the 6W buzzer with different patterns.

```json
{
  "action": "buzzer",
  "pattern": "alarm",
  "duration": 3000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Must be `"buzzer"` |
| `pattern` | string | `"beep"`, `"alarm"`, or `"off"` |
| `duration` | number | Duration in milliseconds |

---

## Event Topics (ESP32 → Web/Server)

### `pillbox/{deviceId}/dose`
Published when a pill is successfully dispensed and retrieved.

```json
{
  "type": "dose",
  "medicationId": "abc123",
  "quantity": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Must be `"dose"` |
| `medicationId` | string | Database ID of dispensed medication |
| `quantity` | number | Number of pills dispensed |

### `pillbox/{deviceId}/request`
Published when the ESP32 boots or requests a schedule sync.

```json
{
  "type": "getSchedule"
}
```

### `pillbox/{deviceId}/status`
Published periodically (every 10 seconds) with device status.

```json
{
  "type": "status",
  "online": true,
  "lastSeen": 1234567890,
  "uptime": 3600,
  "freeHeap": 120000,
  "wifiRssi": -45,
  "ip": "192.168.1.100"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Must be `"status"` |
| `online` | boolean | Device connectivity status |
| `lastSeen` | number | Unix timestamp of last activity |
| `uptime` | number | Seconds since boot |
| `freeHeap` | number | Available heap memory (bytes) |
| `wifiRssi` | number | WiFi signal strength (dBm) |
| `ip` | string | Device IP address |

### `pillbox/{deviceId}/telemetry`
Published every 2 seconds with sensor readings.

```json
{
  "type": "telemetry",
  "timestamp": 1234567890,
  "ultrasonic": {
    "distance": 15.5,
    "handDetected": true
  },
  "motors": {
    "stepper": {
      "moving": false,
      "position": 512
    },
    "servo": {
      "angle": 0
    }
  },
  "buzzer": {
    "active": false
  },
  "medSlotCount": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Must be `"telemetry"` |
| `timestamp` | number | Milliseconds since boot |
| `ultrasonic.distance` | number | Distance in cm |
| `ultrasonic.handDetected` | boolean | Hand/pill detection |
| `motors.stepper.moving` | boolean | Stepper motor state |
| `motors.stepper.position` | number | Current step position |
| `motors.servo.angle` | number | Current servo angle |
| `buzzer.active` | boolean | Buzzer state |
| `medSlotCount` | number | Number of stored medications |

---

## Topic Summary

| Topic | Direction | QoS | Retained |
|-------|-----------|-----|----------|
| `pillbox/{id}/cmd` | Web → ESP32 | 1 | No |
| `pillbox/{id}/request` | ESP32 → Server | 1 | No |
| `pillbox/{id}/dose` | ESP32 → Web+Server | 1 | Yes |
| `pillbox/{id}/status` | ESP32 → Web | 0 | Yes |
| `pillbox/{id}/telemetry` | ESP32 → Web | 0 | No |
