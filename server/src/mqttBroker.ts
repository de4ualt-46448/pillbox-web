import mqtt from "mqtt";
import { prisma } from "./prisma.js";
import { sendPushToUser } from "./routes/push.js";
import { MQTT_BROKER_URL } from "./config.js";

/**
 * MQTT client for the Z Care pillbox.
 *
 * Supports two modes:
 *   1. External broker (HiveMQ, etc.) — when MQTT_BROKER_URL is set
 *   2. Local aedes broker — when MQTT_BROKER_URL is not set (legacy/local dev)
 *
 * Topic model (per device, default "pillbox-01"):
 *   pillbox/{deviceId}/cmd      web  -> board   {type:"dispense"|"schedule", ...}
 *   pillbox/{deviceId}/request  board-> server  {type:"getSchedule"}
 *   pillbox/{deviceId}/dose     board-> web+svr {type:"dose", medicationId}
 *   pillbox/{deviceId}/status   board-> web     {online, lastSeen}
 *
 * The server acts as an MQTT client so it can record doses (stock
 * decrement + push) and answer schedule requests from the database.
 */

export function startMqttBroker(): void {
  const brokerUrl = MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
  const isExternal = !!MQTT_BROKER_URL;

  if (isExternal) {
    console.log(`[mqtt] connecting to external broker: ${brokerUrl}`);
  } else {
    console.log("[mqtt] no MQTT_BROKER_URL set, starting local broker...");
    startLocalBroker();
  }

  // --- Server-side client (dose recording + schedule answers) ---
  const client = mqtt.connect(brokerUrl);

  client.on("connect", () => {
    client.subscribe("pillbox/+/dose");
    client.subscribe("pillbox/+/request");
    console.log(`[mqtt] server subscriber connected to ${brokerUrl}`);
  });

  client.on("message", async (topic, payload) => {
    try {
      const parts = topic.split("/");
      const deviceId = parts[1];
      const msg = JSON.parse(payload.toString());

      if (topic.endsWith("/dose")) {
        const medId = String(msg.medicationId);
        const med = await prisma.medication.findUnique({ where: { id: medId } });
        if (!med) return;
        const quantity =
          msg.quantity && Number(msg.quantity) > 0 ? Number(msg.quantity) : med.quantityPerDose;
        const [updated] = await prisma.$transaction([
          prisma.medication.update({
            where: { id: med.id },
            data: { pillsRemaining: Math.max(med.pillsRemaining - quantity, 0) },
          }),
          prisma.doseLog.create({
            data: { medicationId: med.id, quantity, source: "hardware" },
          }),
        ]);
        if (med.userId) {
          sendPushToUser(med.userId, {
            title: "Dose recorded",
            body: `${med.name} dispensed`,
            medicationId: med.id,
          }).catch(() => {});
        }
        console.log(`[mqtt] dose recorded ${medId}, remaining ${updated.pillsRemaining}`);
      } else if (topic.endsWith("/request")) {
        // Answer a schedule request with the current medication table.
        const meds = await prisma.medication.findMany({ orderBy: { name: "asc" } });
        const schedulePayload = JSON.stringify({
          type: "schedule",
          meds: meds.map((m) => ({
            medicationId: m.id,
            name: m.name,
            slot: 0,
          })),
        });
        client.publish(`pillbox/${deviceId}/cmd`, schedulePayload, { qos: 1, retain: true });
        console.log(`[mqtt] published schedule to pillbox/${deviceId}/cmd`);
      }
    } catch (err) {
      console.error("[mqtt] message handling error:", (err as Error).message);
    }
  });

  client.on("error", (err) => {
    console.error("[mqtt] client error:", err.message);
  });
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
