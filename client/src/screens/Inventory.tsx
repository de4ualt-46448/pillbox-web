import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMedications } from "../lib/queries";
import { MedicationCard } from "../components/MedicationCard";
import { useAuth } from "../store/auth";
import { subscribeToPush, unsubscribeFromPush, isPushSubscribed } from "../lib/push";

/** "The Green Menu" — main inventory dashboard (ports InventoryScreen.kt). */
export function Inventory() {
  const navigate = useNavigate();
  const { data: medications = [], isLoading, error } = useMedications();
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [pushEnabled, setPushEnabled] = useState(false);

  useEffect(() => {
    isPushSubscribed().then(setPushEnabled);
  }, []);

  const togglePush = async () => {
    if (pushEnabled) {
      await unsubscribeFromPush();
      setPushEnabled(false);
    } else {
      const ok = await subscribeToPush();
      setPushEnabled(ok);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? medications.filter((m) => m.name.toLowerCase().includes(q)) : medications;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [medications, query]);

  const lowStockCount = medications.filter((m) => m.isLowStock).length;

  return (
    <div className="flex flex-col gap-4 pt-2">
      <h1 className="text-xl font-bold text-textPrimary">Your Medications</h1>

      {/* Search bar */}
      <div className="neumorphic-card flex items-center gap-2.5 px-4 py-3.5">
        <span className="text-tealAccent">🔍</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search medications"
          className="flex-1 bg-transparent outline-none text-textPrimary placeholder:text-textSecondary"
        />
      </div>

      {lowStockCount > 0 && (
        <div className="rounded-2xl px-4 py-3 bg-progressLow text-textOnGradient flex items-center gap-2">
          <span>⚠️</span>
          <span className="font-semibold text-sm">
            {lowStockCount === 1
              ? "1 medication is running low"
              : `${lowStockCount} medications are running low`}
          </span>
        </div>
      )}

      {/* Push notification toggle */}
      <button
        onClick={togglePush}
        className={`neumorphic-card px-4 py-3 flex items-center justify-between ${
          pushEnabled ? "bg-paleMint" : ""
        }`}
      >
        <div className="flex items-center gap-2">
          <span>🔔</span>
          <span className="text-sm font-semibold text-textPrimary">
            {pushEnabled ? "Push reminders enabled" : "Enable push reminders"}
          </span>
        </div>
        <div
          className={`w-10 h-6 rounded-full transition-colors flex items-center px-0.5 ${
            pushEnabled ? "bg-forestGreen justify-end" : "bg-textSecondary/30 justify-start"
          }`}
        >
          <div className="w-5 h-5 rounded-full bg-white shadow" />
        </div>
      </button>

      {/* Reminder timers — one per medication, fired by the on-device scheduler */}
      {medications.some((m) => m.timesOfDay.length > 0) && (
        <div className="neumorphic-card p-4 flex flex-col gap-2">
          <div className="text-sm font-semibold text-textPrimary flex items-center gap-2">
            <span>⏰</span> Reminder timers
          </div>
          <div className="flex flex-col gap-1.5">
            {medications
              .filter((m) => m.timesOfDay.length > 0)
              .map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-textPrimary truncate">{m.name}</span>
                  <span className="flex gap-1 shrink-0">
                    {m.timesOfDay.map((t) => (
                      <span
                        key={t}
                        className="text-xs px-2 py-0.5 rounded-full bg-paleMint text-textPrimary font-semibold"
                      >
                        {t}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="neumorphic-card p-3.5 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-softSurfaceHighlight" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-softSurfaceHighlight rounded w-3/4" />
                  <div className="h-3 bg-softSurfaceHighlight rounded w-1/2" />
                </div>
                <div className="w-16 h-8 bg-softSurfaceHighlight rounded-2xl" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="neumorphic-card p-8 text-center text-textSecondary">
          <div className="text-4xl mb-2">⚠️</div>
          <p className="mb-2">Failed to load medications.</p>
          <p className="text-xs text-textSecondary">{(error as Error).message}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="neumorphic-card p-8 text-center text-textSecondary">
          <div className="text-4xl mb-2">📭</div>
          No medications yet. Tap the <span className="font-semibold">＋</span> button to scan a
          label or add one.
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          {filtered.map((med) => (
            <MedicationCard
              key={med.id}
              medication={med}
              onClick={() => navigate(`/medication/${med.id}`)}
            />
          ))}
        </div>
      )}

      {/* Floating add button (top-right), supplementing the bottom nav. */}
      <button
        onClick={() => navigate("/scanner")}
        aria-label="Add medication"
        className="brand-btn fixed right-6 bottom-24 w-14 h-14 rounded-full flex items-center justify-center text-2xl shadow-neumorphic z-10"
      >
        ＋
      </button>
    </div>
  );
}
