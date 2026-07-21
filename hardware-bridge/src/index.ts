import WebSocket from "ws";
import net from "node:net";

/**
 * Local bridge between the Pillbox web server (WebSocket) and the physical
 * ESP32 "Z Care" pillbox (raw TCP). Run this on a machine on the same LAN as
 * the board.
 *
 * To the server (WS, role=bridge): relays schedule/dispense commands and
 * audio frames down to the board, and forwards dose events up to the server.
 *
 * To the ESP32 (TCP):
 *   - AUDIO socket  (BOX_PORT):     4-byte little-endian length + raw audio.
 *   - CONTROL socket(BOX_PORT + 1): newline-delimited JSON both directions.
 *
 * Env:
 *   SERVER_URL   ws://host:port/ws/hardware?role=bridge
 *   BOX_HOST     192.168.x.x   (the ESP32's IP)
 *   BOX_PORT     5000
 */
const SERVER_URL = process.env.SERVER_URL ?? "ws://localhost:4000/ws/hardware?role=bridge";
const BOX_HOST = process.env.BOX_HOST ?? "192.168.4.1";
const BOX_PORT = Number(process.env.BOX_PORT ?? 5000);

let ws: WebSocket | null = null;

let audioSocket: net.Socket | null = null;
let controlSocket: net.Socket | null = null;
let controlBuffer = "";

function connectBox(): void {
  audioSocket = net.connect(BOX_PORT, BOX_HOST, () =>
    console.log(`[bridge] audio TCP  -> ${BOX_HOST}:${BOX_PORT}`),
  );
  controlSocket = net.connect(BOX_PORT + 1, BOX_HOST, () => {
    console.log(`[bridge] control TCP -> ${BOX_HOST}:${BOX_PORT + 1}`);
    // Tell the server the board is online so it can push the schedule.
    ws?.send(JSON.stringify({ type: "hello" }));
    // Ask for the current schedule immediately (ESP32-initiated sync).
    ws?.send(JSON.stringify({ type: "getSchedule" }));
  });

  // ESP32 -> bridge: JSON control lines (e.g. dose events).
  controlSocket.setEncoding("utf8");
  controlSocket.on("data", (chunk) => {
    controlBuffer += chunk;
    let idx: number;
    while ((idx = controlBuffer.indexOf("\n")) >= 0) {
      const line = controlBuffer.slice(0, idx).trim();
      controlBuffer = controlBuffer.slice(idx + 1);
      if (!line) continue;
      try {
        JSON.parse(line); // validate
        ws?.send(line); // forward to server
        console.log(`[bridge] <- board: ${line}`);
      } catch {
        /* ignore malformed line */
      }
    }
  });

  const onErr = (label: string) => (e: Error) =>
    console.error(`[bridge] ${label} error:`, e.message);
  audioSocket.on("error", onErr("audio"));
  controlSocket.on("error", onErr("control"));
  audioSocket.on("close", () => console.log("[bridge] audio socket closed"));
  controlSocket.on("close", () => console.log("[bridge] control socket closed"));
}

// Server -> bridge message handling (schedule / dispense JSON, or audio bytes).
function onServerMessage(data: WebSocket.RawData, isBinary: boolean): void {
  if (isBinary) {
    if (audioSocket?.writable) {
      const buf = data as Buffer;
      const header = Buffer.alloc(4);
      header.writeUInt32LE(buf.length, 0);
      audioSocket.write(header);
      audioSocket.write(buf);
      console.log(`[bridge] streamed ${buf.length} audio bytes to board`);
    }
    return;
  }
  const msg = data.toString();
  if (controlSocket?.writable) {
    controlSocket.write(msg.endsWith("\n") ? msg : msg + "\n");
    console.log(`[bridge] -> board: ${msg.trim()}`);
  }
}

function connectToServer(): void {
  const sock = new WebSocket(SERVER_URL);
  sock.on("open", () => {
    console.log("[bridge] connected to server");
    ws = sock;
    connectBox();
  });
  sock.on("message", onServerMessage);
  sock.on("error", (e) => console.error("[bridge] ws error:", e.message));
  sock.on("close", () => {
    console.log("[bridge] server disconnected; reconnecting in 3s");
    ws = null;
    setTimeout(connectToServer, 3000);
  });
}

connectToServer();
