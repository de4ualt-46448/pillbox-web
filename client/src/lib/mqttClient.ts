import mqtt, { type MqttClient } from "mqtt";

/**
 * MQTT-based hardware client for the Z Care pillbox (replaces the old
 * WebSocket bridge and the Firebase bridge).
 *
 * The web app talks to the ESP32 through the local MQTT broker running in the
 * server (TCP 1883 for the board, WS 8888 for the browser):
 *
 *   pillbox/{deviceId}/cmd        web  -> board   {action:"dispense"|"schedule"|"servo"|"buzzer"}
 *   pillbox/{deviceId}/request    web  -> server  {type:"getSchedule"}
 *   pillbox/{deviceId}/dose       board-> web+server {type:"dose", medicationId}
 *   pillbox/{deviceId}/status     board-> web     {type:"status", online, lastSeen, ...}
 *   pillbox/{deviceId}/telemetry  board-> web     {type:"telemetry", ultrasonic, motors, buzzer}
 *
 * Exposes the same `hardwareClient` interface the UI already uses
 * (connect / fireReminder / refreshSchedule / onDose / onStatus / onTelemetry / sim).
 */

const DEFAULT_DEVICE_ID = "pillbox-01";

// MQTT broker WebSocket endpoint.
// Local dev: aedes broker on ws://localhost:8888
// Production / external: override via VITE_MQTT_WS_URL env var.
const isLocalhost = typeof window !== "undefined" && (
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname.startsWith("192.168.") ||
  window.location.hostname.startsWith("10.")
);
const defaultWsUrl = isLocalhost ? "ws://localhost:8888" : "ws://broker.hivemq.com:8000/mqtt";
const MQTT_WS_URL =
  (import.meta as any).env?.VITE_MQTT_WS_URL || defaultWsUrl;

type DoseHandler = (medicationId: string) => void;
type StatusHandler = (online: boolean) => void;
type TelemetryHandler = (data: TelemetryData) => void;

export interface Esp32Med {
  medicationId: string;
  name: string;
  slot: number;
}

export interface TelemetryData {
  timestamp: number;
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

export interface DeviceStatus {
  type: "status";
  online: boolean;
  lastSeen: number;
  uptime: number;
  freeHeap: number;
  wifiRssi: number;
  ip: string;
}

class MqttHardwareClient {
  private deviceId = DEFAULT_DEVICE_ID;
  private client: MqttClient | null = null;
  private connecting = false;
  private sim = false;
  private doseHandlers = new Set<DoseHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private telemetryHandlers = new Set<TelemetryHandler>();
  private latestTelemetry: TelemetryData | null = null;
  private latestStatus: DeviceStatus | null = null;

  setDeviceId(id: string): void {
    this.deviceId = id;
    if (this.client?.connected) this.resubscribe();
  }

  connect(): void {
    if (this.client?.connected) return;
    if (this.connecting) return;
    this.connecting = true;
    const url = MQTT_WS_URL;
    console.log(`[mqtt] connecting to ${url}...`);
    this.client = mqtt.connect(url, {
      reconnectPeriod: 3000,
      clientId: `web-${Math.random().toString(16).slice(2)}`,
    });

    const onDone = () => { this.connecting = false; };

    this.client.on("connect", () => {
      console.log(`[mqtt] connected to ${url}`);
      this.resubscribe();
      this.emitStatus(true);
    });
    this.client.on("close", () => {
      console.log(`[mqtt] disconnected from ${url}`);
      this.connecting = false;
      this.emitStatus(false);
    });
    this.client.on("error", (err) => {
      console.error(`[mqtt] error:`, err.message);
      onDone();
    });
    this.client.on("message", (topic, payload) => {
      const rawPayload = payload.toString().trim();
      let msg: any;
      try {
        msg = JSON.parse(rawPayload);
      } catch {
        if (topic.endsWith("/status") && (rawPayload === "online" || rawPayload === "offline")) {
          msg = { online: rawPayload === "online" };
        } else {
          return;
        }
      }

      // ---- DOSE EVENT ----
      if (topic.endsWith("/dose") && msg.medicationId) {
        this.doseHandlers.forEach((h) => h(String(msg.medicationId)));
      }

      // ---- STATUS UPDATE ----
      else if (topic.endsWith("/status")) {
        const lastSeen = msg.lastSeen ? Number(msg.lastSeen) : Math.floor(Date.now() / 1000);
        const online = !!msg.online && Date.now() / 1000 - lastSeen < 30;
        this.latestStatus = {
          type: "status",
          online,
          lastSeen,
          uptime: msg.uptime ?? 0,
          freeHeap: msg.freeHeap ?? 0,
          wifiRssi: msg.wifiRssi ?? 0,
          ip: msg.ip ?? "",
        };
        this.statusHandlers.forEach((h) => h(online));
      }

      // ---- TELEMETRY DATA ----
      else if (topic.endsWith("/telemetry")) {
        this.latestTelemetry = {
          timestamp: msg.timestamp ?? Date.now(),
          ultrasonic: {
            distance: msg.ultrasonic?.distance ?? 0,
            handDetected: msg.ultrasonic?.handDetected ?? false,
          },
          motors: {
            stepper: {
              moving: msg.motors?.stepper?.moving ?? false,
              position: msg.motors?.stepper?.position ?? 0,
            },
            servo: {
              angle: msg.motors?.servo?.angle ?? 0,
            },
          },
          buzzer: {
            active: msg.buzzer?.active ?? false,
          },
          medSlotCount: msg.medSlotCount ?? 0,
        };
        this.telemetryHandlers.forEach((h) => h(this.latestTelemetry!));
      }
    });
  }

  private resubscribe(): void {
    this.client?.subscribe(`pillbox/${this.deviceId}/dose`);
    this.client?.subscribe(`pillbox/${this.deviceId}/status`);
    this.client?.subscribe(`pillbox/${this.deviceId}/telemetry`);
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
      JSON.stringify({ action: "dispense", medicationId, text }),
      { qos: 1 },
    );
  }

  /** Send a dispense command with specific motor steps and slot. */
  dispense(medicationId: string, slot: number, steps: number, quantity: number = 1): void {
    if (this.sim) {
      setTimeout(() => this.simulateDose(medicationId, quantity), 1500);
      return;
    }
    if (!this.isConnected()) return;
    this.client!.publish(
      `pillbox/${this.deviceId}/cmd`,
      JSON.stringify({ action: "dispense", medicationId, slot, steps, quantity }),
      { qos: 1 },
    );
  }

  /** Control the servo motor (trapdoor). */
  servo(position: number): void {
    if (!this.isConnected()) return;
    this.client!.publish(
      `pillbox/${this.deviceId}/cmd`,
      JSON.stringify({ action: "servo", position }),
      { qos: 1 },
    );
  }

  /** Trigger the buzzer with a pattern. */
  buzzer(pattern: "beep" | "alarm" | "off", duration: number = 1000): void {
    if (!this.isConnected()) return;
    this.client!.publish(
      `pillbox/${this.deviceId}/cmd`,
      JSON.stringify({ action: "buzzer", pattern, duration }),
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
      JSON.stringify({ action: "schedule", meds }),
      { qos: 1, retain: true },
    );
  }

  /** Get the latest telemetry data. */
  getLatestTelemetry(): TelemetryData | null {
    return this.latestTelemetry;
  }

  /** Get the latest device status. */
  getLatestStatus(): DeviceStatus | null {
    return this.latestStatus;
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

  onTelemetry(handler: TelemetryHandler): () => void {
    this.telemetryHandlers.add(handler);
    return () => this.telemetryHandlers.delete(handler);
  }

  private emitStatus(online: boolean): void {
    this.statusHandlers.forEach((h) => h(online));
  }
}

export const hardwareClient = new MqttHardwareClient();
