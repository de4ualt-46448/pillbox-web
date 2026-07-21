import { useEffect, useState } from "react";
import { useRecordDose } from "../lib/queries";
import { hardwareClient } from "../lib/mqttClient";
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
 * and offers a local "simulate dose" so the flow is testable without hardware.
 */
export function HardwarePanel({ open, onClose, medications, voiceProfiles }: Props) {
  const [online, setOnline] = useState(false);
  const [boxSeen, setBoxSeen] = useState(false);
  const [simOn, setSimOn] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [doseQuantity, setDoseQuantity] = useState(1);
  const recordDose = useRecordDose();

  const push = (kind: LogEntry["kind"], text: string) =>
    setLog((l) => [{ id: Date.now() + Math.random(), kind, text }, ...l].slice(0, 30));

  useEffect(() => {
    if (!open) return;
    const offStatus = hardwareClient.onStatus((o) => {
      setOnline(o);
      push("info", o ? "Connected to pillbox relay" : "Relay disconnected — retrying…");
    });
    const offDose = hardwareClient.onDose((medId) => {
      const med = medications.find((m) => m.id === medId);
      setBoxSeen(true);
      push("dose", `Dose taken: ${med?.name ?? medId} (stock updated)`);
    });
    hardwareClient.connect();
    return () => {
      offStatus();
      offDose();
    };
  }, [open, medications]);

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
    hardwareClient.fireReminder(med.id, text, defaultVoice?.remoteVoiceId);
    push("reminder", `Dispense sent for ${med.name} → board`);
  };

  const toggleSim = () => {
    if (simOn) {
      hardwareClient.disconnectSim();
      setSimOn(false);
      push("info", "Simulated pillbox disconnected");
    } else {
      hardwareClient.connectSim();
      setSimOn(true);
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
            hint={boxSeen ? "received dose events" : "no board seen yet"}
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
          To connect a real Z Care ESP32: flash <code>esp32/firmware/firmware.ino</code>, then run
          the <code>hardware-bridge</code> on a machine on the same LAN as the board (set{" "}
          <code>BOX_HOST</code> to the ESP32 IP). The board receives the schedule and reports drops
          automatically.
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
