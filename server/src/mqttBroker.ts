import mqtt from "mqtt";
import { prisma } from "./prisma.js";
import { sendPushToUser } from "./routes/push.js";
import { MQTT_BROKER_URL } from "./config.js";

// Module-scoped reconnection attempts counter for exponential backoff
let reconnectAttempts = 0;
let localBrokerStarted = false;

/**
 * MQTT client for the Z Care pillbox.
 *
 * Supports two modes:
 *   1. External broker (HiveMQ, etc.) — when MQTT_BROKER_URL is set
 *   2. Local aedes broker — when MQTT_BROKER_URL is not set (legacy/local dev)
 *
 * Topic model (per device, default "pillbox-01"):
 *   pillbox/{deviceId}/cmd        web  -> board   {action:"dispense"|"schedule"|"servo"|"buzzer"}
 *   pillbox/{deviceId}/request    board-> server  {type:"getSchedule"}
 *   pillbox/{deviceId}/dose       board-> web+svr {type:"dose", medicationId}
 *   pillbox/{deviceId}/status     board-> web     {type:"status", online, lastSeen, uptime, ...}
 *   pillbox/{deviceId}/telemetry  board-> web     {type:"telemetry", ultrasonic, motors, buzzer}
 *
 * The server acts as an MQTT client so it can record doses (stock
 * decrement + push) and answer schedule requests from the database.
 */

// Track device telemetry for real-time updates
interface DeviceTelemetry {
  deviceId: string;
  online: boolean;
  lastSeen: number;
  uptime: number;
  freeHeap: number;
  wifiRssi: number;
  ip: string;
  ultrasonic: {
    distance: number;
    handDetected: boolean;
  };
  motors: {
    stepper: {
      moving: boolean;
      position: number;
    };
    servo: {
      angle: number;
    };
  };
  buzzer: {
    active: boolean;
  };
  medSlotCount: number;
}

const deviceTelemetry = new Map<string, DeviceTelemetry>();

// Export for external access (e.g., REST API)
export function getDeviceTelemetry(deviceId: string): DeviceTelemetry | undefined {
  return deviceTelemetry.get(deviceId);
}

export function getAllDeviceTelemetry(): DeviceTelemetry[] {
  return Array.from(deviceTelemetry.values());
}

// Publish a command to a device's cmd topic (used by REST API)
let mqttClient: ReturnType<typeof mqtt.connect> | null = null;

export function publishDeviceCommand(deviceId: string, message: Record<string, unknown>): void {
  if (!mqttClient?.connected) throw new Error("MQTT client not connected");
  mqttClient.publish(`pillbox/${deviceId}/cmd`, JSON.stringify(message), { qos: 1 });
}

export function startMqttBroker(): void {
  const brokerUrl = MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
  const isExternal = !!MQTT_BROKER_URL;

  if (isExternal) {
    console.log(`[mqtt] connecting to external broker: ${brokerUrl}`);
  } else if (!localBrokerStarted) {
    console.log("[mqtt] no MQTT_BROKER_URL set, starting local broker...");
    startLocalBroker();
    localBrokerStarted = true;
  }

  // --- Server-side client (dose recording + schedule answers) ---
  // Disable auto-reconnect — we handle reconnection manually with exponential backoff
  connectClient(brokerUrl);
}

function connectClient(brokerUrl: string): void {
  mqttClient = mqtt.connect(brokerUrl, { reconnectPeriod: 0 });
  const client = mqttClient;

  client.on("connect", () => {
    reconnectAttempts = 0; // reset on successful connection
    client.subscribe("pillbox/+/dose");
    client.subscribe("pillbox/+/request");
    client.subscribe("pillbox/+/status");
    client.subscribe("pillbox/+/telemetry");
    client.subscribe("pillbox/+/event");
    console.log(`[mqtt] server subscriber connected to ${brokerUrl}`);
  });

  client.on("reconnect", () => {
    reconnectAttempts++;
    console.log(`[mqtt] reconnect attempt #${reconnectAttempts}`);
  });

  client.on("message", async (topic, payload) => {
    const rawPayload = payload.toString().trim();
    try {
      const parts = topic.split("/");
      const deviceId = parts[1];
      
      let msg: any = null;
      try {
        msg = JSON.parse(rawPayload);
      } catch {
        if (topic.endsWith("/status") && (rawPayload === "online" || rawPayload === "offline")) {
          msg = { type: "status", online: rawPayload === "online" };
        }
      }

      if (!msg) {
        console.warn(`[mqtt] non-JSON message received on topic ${topic}: ${rawPayload}`);
        return;
      }

      // ---- DOSE EVENT ----
      if (topic.endsWith("/dose")) {
        if (msg.confirmed === false) return;
        const medId = String(msg.medicationId || "");
        if (!medId) return;
        const med = await prisma.medication.findUnique({ where: { id: medId } });
        if (!med) return;
        const quantity =
          msg.quantity && Number(msg.quantity) > 0 ? Math.min(Number(msg.quantity), 100) : med.quantityPerDose;
        const hardwareEventId = [msg.occurrenceId, msg.commandId].filter(Boolean).join("|") || null;

        if (hardwareEventId) {
          const existing = await prisma.doseLog.findUnique({ where: { hardwareEventId } });
          if (existing) {
            console.log(`[mqtt] duplicate dose ignored ${hardwareEventId}`);
            return;
          }
        }

        try {
          const [updated] = await prisma.$transaction([
            prisma.medication.update({
              where: { id: med.id },
              data: { pillsRemaining: Math.max(med.pillsRemaining - quantity, 0) },
            }),
            prisma.doseLog.create({
              data: {
                medicationId: med.id,
                quantity,
                source: "hardware",
                hardwareEventId,
              },
            }),
          ]);
          if (med.userId) {
            sendPushToUser(med.userId, {
              title: "Dose recorded",
              body: `${med.name} dispensed`,
              medicationId: med.id,
            }).catch(() => {});
          }
          console.log(`[mqtt] dose recorded ${medId} x${quantity}, remaining ${updated.pillsRemaining}`);
        } catch (error) {
          // A concurrent duplicate can race the pre-check; the unique index makes
          // the second write fail safely without a second stock decrement.
          if ((error as { code?: string }).code === "P2002" && hardwareEventId) {
            console.log(`[mqtt] concurrent duplicate dose ignored ${hardwareEventId}`);
            return;
          }
          throw error;
        }
      }

      // ---- SCHEDULE REQUEST ----
      else if (topic.endsWith("/request")) {
        // Answer with the website's authoritative medication schedule and dose quantity.
        const meds = await prisma.medication.findMany({ orderBy: { name: "asc" } });
        const latestUpdate = meds.reduce(
          (latest, medication) => Math.max(latest, medication.updatedAt.getTime()),
          0,
        );
        const schedulePayload = JSON.stringify({
          action: "schedule",
          scheduleVersion: `${latestUpdate}:${meds.length}`,
          timezone: process.env.TZ || "UTC",
          meds: meds.map((m, index) => ({
            medicationId: m.id,
            name: m.name,
            dosage: m.dosage,
            timesOfDay: m.timesOfDay.split(",").map((time) => time.trim()).filter(Boolean),
            quantityPerDose: m.quantityPerDose,
            slot: index,
          })),
        });
        client.publish(`pillbox/${deviceId}/cmd`, schedulePayload, { qos: 1, retain: true });
        console.log(`[mqtt] published ${meds.length}-medication schedule to pillbox/${deviceId}/cmd`);
      }

      // ---- DEVICE EVENT ----
      else if (topic.endsWith("/event")) {
        console.log(`[mqtt] device event from ${deviceId}: ${msg.type || "unknown"}`);
      }

      // ---- STATUS UPDATE ----
      else if (topic.endsWith("/status")) {
        const telemetry = deviceTelemetry.get(deviceId) || createDefaultTelemetry(deviceId);
        telemetry.online = msg.online ?? true;
        telemetry.lastSeen = msg.lastSeen ?? Math.floor(Date.now() / 1000);
        telemetry.uptime = msg.uptime ?? 0;
        telemetry.freeHeap = msg.freeHeap ?? 0;
        telemetry.wifiRssi = msg.wifiRssi ?? 0;
        telemetry.ip = msg.ip ?? "";
        deviceTelemetry.set(deviceId, telemetry);
        console.log(`[mqtt] status from ${deviceId}: online=${telemetry.online}`);
      }

      // ---- TELEMETRY DATA ----
      else if (topic.endsWith("/telemetry")) {
        const telemetry = deviceTelemetry.get(deviceId) || createDefaultTelemetry(deviceId);
        telemetry.ultrasonic = {
          distance: msg.ultrasonic?.distance ?? 0,
          handDetected: msg.ultrasonic?.handDetected ?? false,
        };
        telemetry.motors = {
          stepper: {
            moving: msg.motors?.stepper?.moving ?? false,
            position: msg.motors?.stepper?.position ?? 0,
          },
          servo: {
            angle: msg.motors?.servo?.angle ?? 0,
          },
        };
        telemetry.buzzer = {
          active: msg.buzzer?.active ?? false,
        };
        telemetry.medSlotCount = msg.medSlotCount ?? 0;
        deviceTelemetry.set(deviceId, telemetry);

        // Auto-confirm pill retrieval if hand detected near sensor
        if (telemetry.ultrasonic.handDetected) {
          console.log(`[mqtt] hand detected by ${deviceId} at ${telemetry.ultrasonic.distance}cm`);
        }
      }
    } catch (err) {
      console.error("[mqtt] message handling error:", (err as Error).message);
    }
  });

  client.on("error", (err) => {
    console.error("[mqtt] client error:", err.message);
  });

  client.on("close", () => {
    // Increment attempts and calculate exponential backoff (max 30s)
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    console.warn(`[mqtt] connection closed, retry #${reconnectAttempts} in ${delay}ms`);
    setTimeout(() => {
      console.log('[mqtt] attempting reconnection...');
      // Only reconnect the client, not restart the broker
      connectClient(brokerUrl);
    }, delay);
  });
}

function createDefaultTelemetry(deviceId: string): DeviceTelemetry {
  return {
    deviceId,
    online: false,
    lastSeen: 0,
    uptime: 0,
    freeHeap: 0,
    wifiRssi: 0,
    ip: "",
    ultrasonic: { distance: 0, handDetected: false },
    motors: {
      stepper: { moving: false, position: 0 },
      servo: { angle: 0 },
    },
    buzzer: { active: false },
    medSlotCount: 0,
  };
}

/**
 * Start the local aedes broker (only used in dev / when no external broker).
 * This function is dynamically imported to avoid loading aedes when not needed.
 */
async function startLocalBroker(): Promise<void> {
  const { default: aedesFactory } = await import("aedes");
  const { createServer } = await import("node:net");
  const { WebSocketServer } = await import("ws");
  const { Duplex } = await import("node:stream");

  const aedes = new aedesFactory();
  const MQTT_TCP_PORT = 1883;
  const MQTT_WS_PORT = 8888;

  const tcp = createServer(aedes.handle);
  tcp.listen(MQTT_TCP_PORT, () => {
    console.log(`[mqtt] local TCP broker listening on ${MQTT_TCP_PORT}`);
  });

  const wss = new WebSocketServer({ port: MQTT_WS_PORT });
  wss.on("connection", (ws) => {
    const stream = new Duplex({
      write(chunk, _enc, cb) {
        ws.send(chunk, (err?: Error) => cb(err ?? undefined));
      },
      read() {},
    });
    ws.on("message", (data) => stream.push(data as Buffer));
    ws.on("close", () => stream.destroy());
    stream.on("error", () => {});
    aedes.handle(stream);
  });
  console.log(`[mqtt] local WebSocket broker listening on ${MQTT_WS_PORT}`);
}
