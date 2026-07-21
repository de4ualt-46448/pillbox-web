import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { parsePrescription } from "../lib/prescriptionParser";
import { useCreateMedication } from "../lib/queries";
import type { ParsedMedication } from "../types";

type ScanMode = "label" | "prescription";

interface NvidiaParsed {
  name?: string | null;
  dosage?: string | null;
  frequency?: string | null;
  timesOfDay?: string[];
  totalQuantity?: number | null;
  quantityPerDose?: number | null;
  rawText?: string;
}

interface ReviewLocationState {
  rawText?: string;
  mode?: ScanMode;
  parsed?: NvidiaParsed | null;
}

/**
 * Always-review-before-save step (ports ScanReviewScreen.kt). OCR extraction
 * is best-effort, so every field is pre-filled but editable before save.
 * In "prescription" mode the times are auto-detected and called out as the
 * reminder timers that will be added.
 *
 * When the NVIDIA NIM vision model returns structured `parsed` data we use
 * it directly. Otherwise we fall back to the regex `parsePrescription` over
 * the raw text.
 */
export function ScanReview() {
  const location = useLocation();
  const navigate = useNavigate();
  const createMed = useCreateMedication();
  const state = (location.state as ReviewLocationState | null) ?? {};
  const rawText = state.rawText ?? "";
  const mode = (state.mode ?? "label") as ScanMode;
  const nvidiaParsed = state.parsed ?? null;

  const parsed: ParsedMedication = useMemo(() => {
    if (nvidiaParsed) {
      return {
        name: nvidiaParsed.name ?? null,
        dosage: nvidiaParsed.dosage ?? null,
        frequency: nvidiaParsed.frequency ?? null,
        timesOfDay: Array.isArray(nvidiaParsed.timesOfDay) ? nvidiaParsed.timesOfDay : [],
        totalQuantity: typeof nvidiaParsed.totalQuantity === "number" ? nvidiaParsed.totalQuantity : null,
        quantityPerDose: typeof nvidiaParsed.quantityPerDose === "number" ? nvidiaParsed.quantityPerDose : null,
      };
    }
    return parsePrescription(rawText);
  }, [nvidiaParsed, rawText]);

  const [name, setName] = useState(parsed.name ?? "");
  const [dosage, setDosage] = useState(parsed.dosage ?? "");
  const [frequency, setFrequency] = useState(parsed.frequency ?? "");
  const [timesText, setTimesText] = useState(parsed.timesOfDay.join(", "));
  const [quantityText, setQuantityText] = useState(parsed.totalQuantity?.toString() ?? "");
  const [pillsPerDoseText, setPillsPerDoseText] = useState(parsed.quantityPerDose?.toString() ?? "1");
  const [error, setError] = useState("");

  if (!rawText && !nvidiaParsed) {
    return (
      <div className="pt-10 text-center text-textSecondary">
        Nothing to review.{" "}
        <button className="text-forestGreen" onClick={() => navigate("/scanner")}>
          Scan again
        </button>
      </div>
    );
  }

  const save = async () => {
    setError("");
    const times = timesText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const qty = parseInt(quantityText, 10);
    try {
      await createMed.mutateAsync({
        name: name.trim(),
        dosage: dosage.trim() || "As labeled",
        frequencyRaw: frequency.trim() || "As directed",
        timesOfDay: times,
        totalQuantity: Number.isFinite(qty) && qty > 0 ? qty : 30,
        quantityPerDose: parseInt(pillsPerDoseText, 10) || 1,
      });
      navigate("/");
    } catch (e) {
      setError((e as Error).message || "Could not save. Please try again.");
    }
  };

  const timersDetected = parsed.timesOfDay.length > 0;

  return (
    <div className="flex flex-col gap-4 pt-2">
      <h1 className="text-xl font-bold text-textPrimary">Review Scanned Details</h1>
      <p className="text-textSecondary text-sm">
        {mode === "prescription"
          ? "Scanned from a prescription. We read the schedule and will add reminder timers automatically."
          : "We pre-filled what we could read — please double-check before saving."}
      </p>

      {mode === "prescription" && (
        <div
          className={`rounded-2xl px-4 py-3 flex items-center gap-2 ${
            timersDetected ? "bg-paleMint text-textPrimary" : "bg-progressLow text-textOnGradient"
          }`}
        >
          <span>⏰</span>
          <span className="font-semibold text-sm">
            {timersDetected
              ? `Reminder timers detected: ${parsed.timesOfDay.join(", ")}`
              : "No times found on the prescription — add them below."}
          </span>
        </div>
      )}

      <ReviewField label="Medication name" value={name} onChange={setName} detected={!!parsed.name} />
      <ReviewField label="Dosage" value={dosage} onChange={setDosage} detected={!!parsed.dosage} />
      <ReviewField label="Frequency" value={frequency} onChange={setFrequency} detected={!!parsed.frequency} />
      <ReviewField label="Times (comma separated, HH:mm)" value={timesText} onChange={setTimesText} detected={parsed.timesOfDay.length > 0} />
      <ReviewField label="Total pill quantity" value={quantityText} onChange={setQuantityText} detected={parsed.totalQuantity !== null} />
      <ReviewField label="Pills per dose" value={pillsPerDoseText} onChange={setPillsPerDoseText} detected={parsed.quantityPerDose !== null} />

      {error && <p className="text-lowStockRed text-sm">{error}</p>}

      <div className="flex gap-3 mt-2">
        <button
          onClick={() => navigate("/scanner", { state: { mode } })}
          className="neumorphic-card flex-1 py-3 font-semibold text-textPrimary"
        >
          Retake
        </button>
        <button
          onClick={save}
          disabled={createMed.isPending || !name.trim()}
          className="brand-btn flex-1 py-3 disabled:opacity-60"
        >
          {createMed.isPending
            ? "Saving…"
            : mode === "prescription"
              ? "Save + add timers"
              : "Save to Inventory"}
        </button>
      </div>
    </div>
  );
}

function ReviewField({
  label,
  value,
  onChange,
  detected,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  detected?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-textPrimary">{label}</span>
        {detected && value && (
          <span className="text-xs text-forestGreen font-medium">Auto-detected</span>
        )}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`Enter ${label.toLowerCase()}...`}
        className="neumorphic-inset px-4 py-3 outline-none text-textPrimary placeholder:text-textSecondary/50"
      />
    </label>
  );
}
