import { useEffect, useState, useCallback } from "react";
import { useRecordDose } from "../lib/queries";
import { hardwareClient, type TelemetryData } from "../lib/mqttClient";
import { api } from "../lib/api";
import type { Medication, VoiceProfile } from "../types";

interface LogEntry {
  id: number;
  kind: "reminder" | "dose" | "info" | "error";
  text: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  medications: Medication[];
  voiceProfiles: VoiceProfile[];
}

/**
 * Hardware control panel — visible entry point for the ESP32 "Z Care" pillbox.
 * Shows the relay/board status, lets you fire a dispense to the real board,
 * displays real-time telemetry from sensors, and offers a local "simulate dose"
 * so the flow is testable without hardware.
 */
export function HardwarePanel({ open, onClose, medications, voiceProfiles }: Props) {
  const [online, setOnline] = useState(false);
  const [boxSeen, setBoxSeen] = useState(false);
  const [simOn, setSimOn] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [doseQuantity, setDoseQuantity] = useState(1);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const recordDose = useRecordDose();

  const push = useCallback((kind: LogEntry["kind"], text: string) =>
    setLog((l) => [{ id: Date.now() + Math.random(), kind, text }, ...l].slice(0, 30)), []);

  useEffect(() => {
    if (!open) return;

    // Reflect current connection state immediately (MQTT may already be connected)
    setOnline(hardwareClient.isConnected());

    // If we already have a status from before the panel opened, mark box as seen
    const existing = hardwareClient.getLatestStatus();
    if (existing?.online) setBoxSeen(true);

    const offStatus = hardwareClient.onStatus((o) => {
      setOnline(o);
      if (o) {
        setBoxSeen(true);
        push("info", "MQTT connected to broker");
      } else {
        push("info", "MQTT disconnected — retrying…");
      }
    });
    const offDose = hardwareClient.onDose((medId) => {
      const med = medications.find((m) => m.id === medId);
      setBoxSeen(true);
      push("dose", `Dose taken: ${med?.name ?? medId} (stock updated)`);
    });
    const offTelemetry = hardwareClient.onTelemetry((data) => {
      setTelemetry(data);
      if (data.ultrasonic.handDetected) {
        push("info", `Hand detected at ${data.ultrasonic.distance.toFixed(1)}cm`);
      }
    });
    const offEvent = hardwareClient.onEvent((event) => {
      const med = medications.find((m) => m.id === event.medicationId);
      const name = med?.name ?? event.medicationId ?? "medication";
      if (event.type === "pill_time") push("reminder", `Pill time started: ${name}; hand sensor active`);
      else if (event.type === "completed") push("dose", `Dispensed ${event.quantity ?? event.quantityDispensed ?? 1} dose unit(s) of ${name}; sensor off`);
      else if (event.type === "missed") push("error", `Missed dose: ${name}`);
      else if (event.type === "rejected") push("error", `Device rejected ${name}: ${event.reason ?? "unknown reason"}`);
    });
    // Poll server for ESP32 device data (real board telemetry)
    let pollTimer: ReturnType<typeof setInterval>;
    async function pollDevice() {
      try {
        const data = await api.get<{ devices: any[] }>("/hardware/devices");
        const device = data.devices?.find((d: any) => d.deviceId === "pillbox-01");
        if (device) {
          if (device.lastSeen) setBoxSeen(true);
          if (device.ultrasonic) {
            setTelemetry(device as TelemetryData);
            if (device.ultrasonic.handDetected) {
              push("info", `Hand detected at ${device.ultrasonic.distance.toFixed(1)}cm`);
            }
          }
        }
      } catch {
        // Server might not have /hardware/devices endpoint — that's ok
      }
    }
    pollTimer = setInterval(pollDevice, 5000);
    pollDevice();

    return () => {
      offStatus();
      offDose();
      offTelemetry();
      offEvent();
      clearInterval(pollTimer);
    };
  }, [open, medications, push]);

  if (!open) return null;

  const med = medications.find((m) => m.id === selected);
  const defaultVoice = voiceProfiles.find((v) => v.isDefault) ?? null;

  const fireDispense = () => {
    if (!med) return;
    if (!online) {
      push("error", "Not connected to the relay. Is the server running?");
      return;
    }
    const text = `It's time to take your ${med.name}, ${med.dosage}.`;
    // Try MQTT first, fall back to REST
    if (hardwareClient.isConnected()) {
      hardwareClient.fireReminder(med.id, text, defaultVoice?.remoteVoiceId, med.quantityPerDose);
      push("reminder", `Dispense sent for ${med.name} → board`);
    } else {
      api.post("/hardware/devices/pillbox-01/dispense", { medicationId: med.id, text, quantityPerDose: med.quantityPerDose })
        .then(() => push("reminder", `Dispense sent for ${med.name} → board (REST)`))
        .catch((e) => push("error", (e as Error).message));
    }
  };

  const fireBuzzer = (pattern: "beep" | "alarm" | "off") => {
    if (!online) {
      push("error", "Not connected to the relay");
      return;
    }
    if (hardwareClient.isConnected()) {
      hardwareClient.buzzer(pattern, 2000);
    } else {
      api.post("/hardware/devices/pillbox-01/buzzer", { pattern, duration: 2000 })
        .catch((e) => push("error", (e as Error).message));
    }
    push("info", `Buzzer ${pattern} command sent`);
  };

  const toggleSim = () => {
    if (simOn) {
      hardwareClient.disconnectSim();
      setSimOn(false);
      setBoxSeen(false);
      push("info", "Simulated pillbox disconnected");
    } else {
      hardwareClient.connectSim();
      setSimOn(true);
      setBoxSeen(true);
      push("info", "Simulated pillbox connected — connector is live");
    }
  };

  const simulateDose = () => {
    if (!med) return;
    const qty = doseQuantity || 1;
    if (simOn) {
      hardwareClient.simulateDose(med.id, qty);
      push("dose", `Simulated drop reported by pillbox: ${med.name} (−${qty})`);
      return;
    }
    setBusy(true);
    recordDose.mutate({ id: med.id, quantity: qty }, {
      onSuccess: () => push("dose", `Simulated dose taken: ${med.name} (−${qty})`),
      onError: (e) => push("error", (e as Error).message),
      onSettled: () => setBusy(false),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-30" onClick={onClose}>
      <div
        className="bg-softSurface w-full max-w-md rounded-t-3xl p-5 pb-8 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-textPrimary">🔌 Hardware</h2>
          <button onClick={onClose} className="text-textSecondary text-xl">✕</button>
        </div>

        {/* Status */}
        <div className="flex flex-col gap-2 mb-4">
          <StatusRow label="App relay (browser → server)" ok={online} hint={online ? "live" : "offline"} />
          <StatusRow
            label="Pillbox board (ESP32)"
            ok={boxSeen}
            hint={simOn ? "simulated" : boxSeen ? "received dose events" : "no board seen yet"}
          />
        </div>

        {/* Simulated pillbox (no hardware needed) */}
        <div className="neumorphic-card p-4 flex flex-col gap-3">
          <div className="text-sm font-semibold text-textPrimary">No ESP32 yet?</div>
          <p className="text-xs text-textSecondary leading-relaxed">
            Connect a simulated pillbox to exercise the full connector (schedule, dispense, dose →
            stock update) with no physical board.
          </p>
          <button
            onClick={toggleSim}
            className={`py-2.5 rounded-xl font-semibold text-sm ${
              simOn ? "bg-lowStockRed text-textOnGradient" : "bg-forestGreen text-textOnGradient"
            }`}
          >
            {simOn ? "Disconnect simulated pillbox" : "Connect simulated pillbox"}
          </button>
        </div>

        {/* Real-time Telemetry (when connected to real board) */}
        {telemetry && (
          <div className="neumorphic-card p-4 flex flex-col gap-3">
            <div className="text-sm font-semibold text-textPrimary">Sensor Data</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Distance</span>
                <div className="font-semibold text-textPrimary">
                  {telemetry.ultrasonic.distance.toFixed(1)} cm
                </div>
              </div>
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Sensor</span>
                <div className={`font-semibold ${telemetry.sensorActive ? "text-mintGreen" : "text-textSecondary"}`}>
                  {telemetry.sensorActive ? "Active at pill time" : "Off"}
                </div>
              </div>
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Hand</span>
                <div className={`font-semibold ${telemetry.ultrasonic.handDetected ? "text-mintGreen" : "text-textSecondary"}`}>
                  {telemetry.ultrasonic.handDetected ? "Detected" : "None"}
                </div>
              </div>
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Stepper</span>
                <div className="font-semibold text-textPrimary">
                  {telemetry.motors.stepper.moving ? "Moving" : "Idle"}
                </div>
              </div>
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Servo</span>
                <div className="font-semibold text-textPrimary">
                  {telemetry.motors.servo.angle}°
                </div>
              </div>
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Buzzer</span>
                <div className={`font-semibold ${telemetry.buzzer.active ? "text-lowStockRed" : "text-textSecondary"}`}>
                  {telemetry.buzzer.active ? "Active" : "Off"}
                </div>
              </div>
              <div className="bg-softSurfaceHighlight p-2 rounded-lg">
                <span className="text-textSecondary">Slots</span>
                <div className="font-semibold text-textPrimary">
                  {telemetry.medSlotCount}
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => fireBuzzer("beep")}
                className="flex-1 py-2 rounded-xl text-xs font-semibold bg-softSurfaceHighlight text-textPrimary"
              >
                Beep
              </button>
              <button
                onClick={() => fireBuzzer("alarm")}
                className="flex-1 py-2 rounded-xl text-xs font-semibold bg-progressLow text-textOnGradient"
              >
                Alarm
              </button>
              <button
                onClick={() => fireBuzzer("off")}
                className="flex-1 py-2 rounded-xl text-xs font-semibold bg-softSurfaceHighlight text-textPrimary"
              >
                Stop
              </button>
            </div>
          </div>
        )}

        {/* Test dispenser */}
        <div className="neumorphic-card p-4 flex flex-col gap-3">
          <div className="text-sm font-semibold text-textPrimary">Test the dispenser</div>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="neumorphic-inset px-3 py-2.5 outline-none text-textPrimary bg-softSurface"
          >
            <option value="">Select a medication…</option>
            {medications.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.dosage})
              </option>
            ))}
          </select>
          <button onClick={fireDispense} disabled={!selected} className="brand-btn py-2.5 disabled:opacity-60">
            Send dispense → board
          </button>
          <div className="flex items-center gap-3 justify-center">
            <span className="text-sm text-textSecondary whitespace-nowrap">Pills:</span>
            <button
              onClick={() => setDoseQuantity((q) => Math.max(1, q - 1))}
              className="w-8 h-8 rounded-lg bg-brandGradient text-textOnGradient text-sm flex items-center justify-center"
            >
              −
            </button>
            <span className="font-semibold text-textPrimary w-6 text-center">{doseQuantity}</span>
            <button
              onClick={() => setDoseQuantity((q) => q + 1)}
              className="w-8 h-8 rounded-lg bg-brandGradient text-textOnGradient text-sm flex items-center justify-center"
            >
              +
            </button>
          </div>
          <button
            onClick={simulateDose}
            disabled={!selected || (busy && !simOn)}
            className="neumorphic-card py-2.5 text-textPrimary font-semibold disabled:opacity-60"
          >
            {simOn ? `Report pill${doseQuantity > 1 ? "s" : ""} taken (via pillbox)` : `Simulate \u201cpill taken\u201d × ${doseQuantity} (no board needed)`}
          </button>
        </div>

        {/* Activity */}
        <div className="mt-4">
          <div className="text-sm font-semibold text-textPrimary mb-2">Activity</div>
          {log.length === 0 ? (
            <div className="text-textSecondary text-sm">No events yet.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {log.map((e) => (
                <div
                  key={e.id}
                  className={`text-sm px-3 py-2 rounded-xl ${
                    e.kind === "error"
                      ? "bg-progressLow text-textOnGradient"
                      : e.kind === "dose"
                        ? "bg-paleMint text-textPrimary"
                        : "bg-softSurfaceHighlight text-textSecondary shadow-neumorphic-sm"
                  }`}
                >
                  {e.text}
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-textSecondary mt-4 leading-relaxed">
          To connect a real Z Care ESP32: flash <code>esp32/firmware/firmware.ino</code>, then
          configure your Wi-Fi credentials and MQTT broker in the firmware's top section.
          For local dev, set <code>MQTT_HOST</code> to your computer's LAN IP.
          For deployment, switch to <code>MQTT_DEPLOY</code> and set the server's
          <code>MQTT_BROKER_URL</code> to the same broker.
        </p>
      </div>
    </div>
  );
}

function StatusRow({ label, ok, hint }: { label: string; ok: boolean; hint: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-textPrimary">{label}</span>
      <span className="flex items-center gap-2 text-sm text-textSecondary">
        {hint}
        <span className={`w-2.5 h-2.5 rounded-full ${ok ? "bg-mintGreen" : "bg-textSecondary"}`} />
      </span>
    </div>
  );
}
