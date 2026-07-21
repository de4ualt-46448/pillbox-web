import mqtt, { type MqttClient } from "mqtt";

/**
 * MQTT-based hardware client for the Z Care pillbox (replaces the old
 * WebSocket bridge and the Firebase bridge).
 *
 * The web app talks to the ESP32 through the local MQTT broker running in the
 * server (TCP 1883 for the board, WS 8888 for the browser):
 *
 *   pillbox/{deviceId}/cmd      web  -> board   {type:"dispense"|"schedule"}
 *   pillbox/{deviceId}/request  web  -> server  {type:"getSchedule"}
 *   pillbox/{deviceId}/dose     board-> web+server {type:"dose", medicationId}
 *   pillbox/{deviceId}/status   board-> web     {online, lastSeen}
 *
 * Exposes the same `hardwareClient` interface the UI already uses
 * (connect / fireReminder / refreshSchedule / onDose / onStatus / sim).
 */

const DEFAULT_DEVICE_ID = "pillbox-01";

// MQTT broker WebSocket endpoint.
// HiveMQ public broker: ws://broker.hivemq.com:8083/mqtt
// Local dev (when server runs its own aedes): ws://localhost:8888
// Override via VITE_MQTT_WS_URL env var.
const MQTT_WS_URL =
  (import.meta as any).env?.VITE_MQTT_WS_URL || "ws://broker.hivemq.com:8083/mqtt";

type DoseHandler = (medicationId: string) => void;
type StatusHandler = (online: boolean) => void;

export interface Esp32Med {
  medicationId: string;
  name: string;
  slot: number;
}

class MqttHardwareClient {
  private deviceId = DEFAULT_DEVICE_ID;
  private client: MqttClient | null = null;
  private sim = false;
  private doseHandlers = new Set<DoseHandler>();
  private statusHandlers = new Set<StatusHandler>();

  setDeviceId(id: string): void {
    this.deviceId = id;
    if (this.client?.connected) this.resubscribe();
  }

  connect(): void {
    if (this.client && this.client.connected) return;
    const url = MQTT_WS_URL;
    this.client = mqtt.connect(url, {
      reconnectPeriod: 3000,
      clientId: `web-${Math.random().toString(16).slice(2)}`,
    });

    this.client.on("connect", () => {
      this.resubscribe();
      this.emitStatus(true);
    });
    this.client.on("close", () => this.emitStatus(false));
    this.client.on("error", () => {});
    this.client.on("message", (topic, payload) => {
      let msg: any;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      if (topic.endsWith("/dose") && msg.medicationId) {
        this.doseHandlers.forEach((h) => h(String(msg.medicationId)));
      } else if (topic.endsWith("/status")) {
        const lastSeen = msg.lastSeen ? Number(msg.lastSeen) : 0;
        const online = !!msg.online && Date.now() / 1000 - lastSeen < 30;
        this.statusHandlers.forEach((h) => h(online));
      }
    });
  }

  private resubscribe(): void {
    this.client?.subscribe(`pillbox/${this.deviceId}/dose`);
    this.client?.subscribe(`pillbox/${this.deviceId}/status`);
  }

  disconnect(): void {
    this.client?.end(true);
    this.client = null;
    this.emitStatus(false);
  }

  /** Fire a dose-time: tell the board to dispense. */
  fireReminder(medicationId: string, text: string, _voiceId?: string | null): void {
    if (this.sim) {
      // No real board: simulate a drop shortly after the reminder.
      setTimeout(() => this.simulateDose(medicationId), 1500);
      return;
    }
    if (!this.isConnected()) {
      this.emitStatus(false);
      return;
    }
    this.client!.publish(
      `pillbox/${this.deviceId}/cmd`,
      JSON.stringify({ type: "dispense", medicationId, text }),
      { qos: 1 },
    );
  }

  /** Ask the server to (re)push the schedule to the board. */
  refreshSchedule(): void {
    if (!this.isConnected()) return;
    this.client!.publish(
      `pillbox/${this.deviceId}/request`,
      JSON.stringify({ type: "getSchedule" }),
      { qos: 1 },
    );
  }

  /** Push the current medication schedule directly to the board. */
  pushSchedule(meds: Esp32Med[]): void {
    this.client?.publish(
      `pillbox/${this.deviceId}/cmd`,
      JSON.stringify({ type: "schedule", meds }),
      { qos: 1, retain: true },
    );
  }

  // ---- software simulation (no physical board) ----
  connectSim(): void {
    this.sim = true;
    this.emitStatus(true);
  }

  disconnectSim(): void {
    this.sim = false;
    this.emitStatus(false);
  }

  /** Simulate a pill drop (routes through the broker so the server records it). */
  simulateDose(medicationId: string, quantity?: number): void {
    if (this.client?.connected) {
      this.client.publish(
        `pillbox/${this.deviceId}/dose`,
        JSON.stringify({ type: "dose", medicationId, quantity: quantity ?? undefined }),
        { qos: 1 },
      );
    } else {
      this.doseHandlers.forEach((h) => h(medicationId));
    }
  }

  isConnected(): boolean {
    return !!this.client && this.client.connected;
  }

  onDose(handler: DoseHandler): () => void {
    this.doseHandlers.add(handler);
    return () => this.doseHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(online: boolean): void {
    this.statusHandlers.forEach((h) => h(online));
  }
}

export const hardwareClient = new MqttHardwareClient();
