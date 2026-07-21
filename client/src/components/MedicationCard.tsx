import { Medication } from "../types";
import { StockDrainBar } from "./StockDrainBar";

interface MedicationCardProps {
  medication: Medication;
  onClick: () => void;
}

/**
 * Inventory row — circular pill icon chip, name + subtitle, gradient
 * "X left" badge, drain bar, and reminder times if set.
 */
export function MedicationCard({ medication, onClick }: MedicationCardProps) {
  return (
    <button
      onClick={onClick}
      className="neumorphic-card p-3.5 flex flex-col gap-3 cursor-pointer active:scale-[0.98] transition-all text-left w-full hover:shadow-lg"
      aria-label={`${medication.name}, ${medication.pillsRemaining} pills remaining`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${
            medication.isLowStock ? "bg-progressLow/20" : "bg-paleMint"
          }`}
        >
          <span className="text-2xl" role="img" aria-label="pill">
            💊
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="font-semibold text-textPrimary truncate">{medication.name}</div>
          <div className="text-textSecondary text-sm truncate">
            {medication.dosage} · {medication.frequencyRaw}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          <div
            className={`rounded-2xl px-3 py-1.5 font-bold text-textOnGradient text-sm whitespace-nowrap ${
              medication.isLowStock ? "bg-progressLow" : "bg-brandGradient"
            }`}
          >
            {medication.pillsRemaining} left
          </div>
          {medication.pillsRemaining <= 0 && (
            <span className="text-xs text-lowStockRed font-semibold">Refill needed</span>
          )}
        </div>
      </div>

      <StockDrainBar fraction={medication.progressFraction} isLow={medication.isLowStock} />

      {/* Reminder times */}
      {medication.timesOfDay.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-textSecondary">⏰</span>
          {medication.timesOfDay.map((t) => (
            <span
              key={t}
              className="text-xs px-2 py-0.5 rounded-full bg-paleMint text-forestGreen font-medium"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
