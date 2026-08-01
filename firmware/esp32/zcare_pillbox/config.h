/*
 * config.h — Z Care Smart Pillbox (ESP32)
 * ─────────────────────────────────────────────────────────────
 * EDIT THIS FILE with your WiFi and MQTT settings, then flash
 * zcare_pillbox.ino to the board.
 *
 * For cloud deployment, point MQTT_HOST at the same public broker
 * the server uses (broker.hivemq.com) so the board and server can
 * reach each other from ANY network.
 */

#ifndef ZCARE_CONFIG_H
#define ZCARE_CONFIG_H

/* ── WiFi ─────────────────────────────────────────────────── */
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASS "YOUR_WIFI_PASSWORD"

/* ── MQTT broker ──────────────────────────────────────────── */
/* HiveMQ public broker — reachable from any network. */
#define MQTT_HOST "broker.hivemq.com"
#define MQTT_PORT 1883
#define MQTT_USER ""          /* empty for the public broker */
#define MQTT_PASS ""          /* empty for the public broker */

/* ── Device identity ──────────────────────────────────────── */
#define DEVICE_ID "pillbox-01"

/* ── Hardware pins (match README "Hardware Pinout") ───────── */
#define PIN_STEPPER_IN1 19
#define PIN_STEPPER_IN2 22
#define PIN_STEPPER_IN3 21
#define PIN_STEPPER_IN4 23
#define PIN_SERVO       13
#define PIN_US_TRIG      5
#define PIN_US_ECHO     18
#define PIN_BUZZER       4

/* ── Mechanics ────────────────────────────────────────────── */
#define STEPS_PER_REV   2048   /* 28BYJ-48 (half-step) full revolution */
#define SLOTS_PER_REV      8   /* carousel slot count */
#define STEPS_PER_SLOT  (STEPS_PER_REV / SLOTS_PER_REV)
#define STEP_INTERVAL_US 2000  /* microseconds per half-step (~500 steps/s) */

#define SERVO_CLOSED   0       /* degrees — trapdoor closed */
#define SERVO_OPEN    90       /* degrees — trapdoor open (dispense) */
#define SERVO_SPEED  100       /* ESP32Servo: microseconds per 60° */

#define DISPENSE_OPEN_MS   900 /* how long the trapdoor stays open per pill */
#define DISPENSE_CLOSE_MS  500 /* pause after closing before the next pill */

#define STATUS_INTERVAL_MS    10000UL  /* publish /status every 10s */
#define TELEMETRY_INTERVAL_MS  2000UL  /* publish /telemetry every 2s */

#define SERIAL_BAUD 115200

#endif /* ZCARE_CONFIG_H */
