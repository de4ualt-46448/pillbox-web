import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "./prisma.js";
import { verifyToken } from "./auth.js";
import { synthesize } from "./voice/elevenlabs.js";
import { sendPushToUser } from "./routes/push.js";
import { WS_PATH } from "./config.js";

interface ClientSocket extends WebSocket {
  userId?: string;
  role?: "web" | "bridge";
}

/**
 * Hardware relay for a real ESP32 "Z Care" pillbox.
 *
 * Browsers can't open raw TCP to the ESP32, so a local `hardware-bridge`
 * agent connects here over WebSocket and opens two TCP sockets to the board:
 *   - AUDIO socket (BOX_PORT):       4-byte little-endian length + raw audio.
 *   - CONTROL socket (BOX_PORT + 1): newline-delimited JSON both directions.
 *
 * Message contract
 * ----------------
 * Bridge -> Server (JSON over WS):
 *   {type:"hello"}                     board/bridge is ready
 *   {type:"getSchedule"}               request latest schedule
 *   {type:"dose", medicationId}        IR break-beam confirmed a dispense
 *   {type:"status", ...}               optional telemetry
 *
 * Server -> Bridge:
 *   <binary audio bytes>               forwarded to the AUDIO socket
 *   {type:"schedule", meds:[...]}      full medication schedule
 *   {type:"dispense", medicationId, text}  actuate the slot + alert
 *
 * Web -> Server (role=web, auth token in query):
 *   {type:"refreshSchedule"}           re-push schedule to the board
 *   {type:"reminder", medicationId, text, voiceId?}  fire a dose time
 *
 * Server -> Web:
 *   {type:"dose-ack", medicationId, pillsRemaining}
 *   {type:"hardware-offline"} | {type:"error", message}
 */
export function attachHardwareWs(server: Server): void {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  let bridge: ClientSocket | null = null;
  let bridgeUserId: string | null = null;
  const webClients = new Set<ClientSocket>();

  async function pushSchedule(): Promise<void> {
    if (!bridge || bridge.readyState !== WebSocket.OPEN || !bridgeUserId) return;
    const meds = await prisma.medication.findMany({
      where: { userId: bridgeUserId },
      select: {
        id: true,
        name: true,
        dosage: true,
        timesOfDay: true,
        voiceProfileId: true,
      },
      orderBy: { name: "asc" },
    });
    const payload = {
      type: "schedule",
      meds: meds.map((m) => ({
        medicationId: m.id,
        name: m.name,
        dosage: m.dosage,
        timesOfDay: m.timesOfDay ? m.timesOfDay.split(",").map((t) => t.trim()).filter(Boolean) : [],
        voiceProfileId: m.voiceProfileId,
      })),
    };
    bridge.send(JSON.stringify(payload));
  }

  wss.on("connection", (ws: ClientSocket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") ?? "";

    // A "sim" connection is a software stand-in for the physical bridge (used
    // when there's no ESP32 yet). It speaks the EXACT same protocol, so the
    // whole chain — schedule push, dispense, dose → stock decrement — works
    // end to end without hardware. It must authenticate like a web client.
    const isBridge = role === "bridge";
    const isSim = role === "sim";
    if (isBridge || isSim) {
      if (isSim) {
        try {
          const payload = verifyToken(token);
          bridgeUserId = payload.userId;
        } catch {
          ws.close(4001, "unauthorized");
          return;
        }
      } else {
        bridgeUserId = null;
      }
      bridge = ws;
      console.log(`[ws] ${isSim ? "simulated" : "hardware"} bridge connected`);
      ws.on("message", async (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "dose" && msg.medicationId) {
          const med = await prisma.medication.findUnique({ where: { id: String(msg.medicationId) } });
          if (med) {
            const quantity = (msg.quantity && Number(msg.quantity) > 0)
              ? Number(msg.quantity)
              : med.quantityPerDose;
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
                },
              }),
            ]);
            const ack = JSON.stringify({
              type: "dose-ack",
              medicationId: med.id,
              pillsRemaining: updated.pillsRemaining,
            });
            webClients.forEach((c) => {
              if (c.userId === med.userId && c.readyState === WebSocket.OPEN) c.send(ack);
            });
          }
        } else if (msg.type === "getSchedule") {
          await pushSchedule();
        } else if (msg.type === "hello") {
          if (bridgeUserId) await pushSchedule();
        }
      });
      ws.on("close", () => {
        if (bridge === ws) {
          bridge = null;
          bridgeUserId = null;
        }
      });
      return;
    }

    // Web client
    try {
      const payload = verifyToken(token);
      ws.userId = payload.userId;
      ws.role = "web";
      webClients.add(ws);
    } catch {
      ws.close(4001, "unauthorized");
      return;
    }

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "refreshSchedule") {
        if (bridgeUserId && bridgeUserId !== ws.userId) return;
        bridgeUserId = ws.userId!;
        await pushSchedule();
        return;
      }

      if (msg.type === "reminder") {
        if (!bridge || bridge.readyState !== WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "hardware-offline" }));
          // Still send push notification even if hardware is offline
          if (ws.userId) {
            sendPushToUser(ws.userId, {
              title: "Pillbox Reminder",
              body: msg.text ?? "Time to take your medication",
              medicationId: msg.medicationId,
            }).catch(() => {});
          }
          return;
        }
        bridgeUserId = ws.userId!;
        // Tell the board which slot to dispense + alert.
        bridge.send(JSON.stringify({ type: "dispense", medicationId: msg.medicationId, text: msg.text }));
        // Send push notification to user's other devices
        if (ws.userId) {
          sendPushToUser(ws.userId, {
            title: "Pillbox Reminder",
            body: msg.text ?? "Time to take your medication",
            medicationId: msg.medicationId,
          }).catch(() => {});
        }
        // If a cloned voice is selected, stream the synthesized audio to the board.
        if (msg.voiceId) {
          try {
            const buf = await synthesize(msg.voiceId, msg.text ?? "Medication reminder");
            bridge.send(buf); // binary frame -> AUDIO socket
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
          }
        }
      }
    });

    ws.on("close", () => {
      webClients.delete(ws);
    });
  });
}
