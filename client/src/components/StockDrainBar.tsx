interface StockDrainBarProps {
  fraction: number;
  isLow: boolean;
}

/** The "green bar that drains as pill count gets low" from the spec. */
export function StockDrainBar({ fraction, isLow }: StockDrainBarProps) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="w-full h-2 rounded-full bg-[#DDE7E3] overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${isLow ? "bg-progressLow" : "bg-progressHealthy"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
