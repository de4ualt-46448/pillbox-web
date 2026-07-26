import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSetStock, useDeleteMedication, useUpdateMedication, useDoseHistory } from "../lib/queries";
import type { Medication } from "../types";

/** Detail / edit screen — ports MedicationDetailScreen.kt. */
export function MedicationDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [pending, setPending] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDosage, setEditDosage] = useState("");
  const [editFrequency, setEditFrequency] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  const setStock = useSetStock();
  const delMed = useDeleteMedication();
  const updateMed = useUpdateMedication();
  const { data: doseHistory } = useDoseHistory(id);

  const { data: med, isLoading, error } = useQuery<Medication>({
    queryKey: ["medications", id],
    queryFn: () => api.get(`/medications/${id}`),
    enabled: !!id,
  });

  useEffect(() => {
    if (med) setPending(med.pillsRemaining);
  }, [med]);

  if (isLoading) return <p className="text-textSecondary">Loading…</p>;
  if (error || !med) return <p className="text-lowStockRed">Medication not found.</p>;

  const saveStock = async () => {
    await setStock.mutateAsync({ id, pillsRemaining: pending });
    setSaveMsg("Stock updated");
    setTimeout(() => setSaveMsg(""), 2000);
  };

  const startEditing = () => {
    setEditName(med.name);
    setEditDosage(med.dosage);
    setEditFrequency(med.frequencyRaw);
    setEditNotes(med.notes);
    setEditing(true);
  };

  const saveEdits = async () => {
    await updateMed.mutateAsync({
      id,
      name: editName.trim(),
      dosage: editDosage.trim(),
      frequencyRaw: editFrequency.trim(),
      notes: editNotes.trim(),
    });
    setEditing(false);
    setSaveMsg("Medication updated");
    setTimeout(() => setSaveMsg(""), 2000);
  };

  const confirmDelete = async () => {
    await delMed.mutateAsync(id);
    navigate("/");
  };

  return (
    <div className="flex flex-col gap-5 pt-2">
      <div className="flex justify-between items-center">
        <button onClick={() => navigate(-1)} aria-label="Back" className="neumorphic-card w-11 h-11 rounded-full flex items-center justify-center">
          ‹
        </button>
        <div className="flex gap-2">
          {editing ? (
            <button onClick={() => setEditing(false)} className="text-textSecondary text-sm">Cancel</button>
          ) : (
            <button onClick={startEditing} className="text-forestGreen text-sm">Edit</button>
          )}
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="text-lowStockRed text-sm"
          >
            Delete
          </button>
        </div>
      </div>

      {saveMsg && (
        <div className="bg-paleMint text-textPrimary text-sm px-4 py-2 rounded-xl text-center font-semibold">
          {saveMsg}
        </div>
      )}

      <div className="h-40 rounded-3xl bg-paleMint flex items-center justify-center text-6xl">💊</div>

      <div className="neumorphic-card px-4 py-4 flex justify-between items-center">
        <div>
          {editing ? (
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="font-semibold text-textPrimary bg-transparent border-b border-textSecondary outline-none w-full"
            />
          ) : (
            <div className="font-semibold text-textPrimary">{med.name}</div>
          )}
          {editing ? (
            <input
              value={editFrequency}
              onChange={(e) => setEditFrequency(e.target.value)}
              className="text-textSecondary text-sm bg-transparent border-b border-textSecondary outline-none w-full mt-1"
            />
          ) : (
            <div className="text-textSecondary text-sm">{med.frequencyRaw}</div>
          )}
        </div>
        <div className="text-forestGreen font-bold text-xl">{med.pillsRemaining} left</div>
      </div>

      <div>
        <div className="text-textSecondary text-sm mb-2">Dosage</div>
        <div className="neumorphic-card px-4 py-4 flex justify-between items-center">
          {editing ? (
            <input
              value={editDosage}
              onChange={(e) => setEditDosage(e.target.value)}
              className="text-textPrimary font-semibold bg-transparent border-b border-textSecondary outline-none w-full"
            />
          ) : (
            <span className="text-textPrimary font-semibold">{med.dosage}</span>
          )}
        </div>
      </div>

      <div>
        <div className="text-textSecondary text-sm mb-2">Pills per dose</div>
        <div className="neumorphic-card px-4 py-4">
          <span className="text-textPrimary font-semibold">{med.quantityPerDose}</span>
        </div>
      </div>

      <div>
        <div className="text-textSecondary text-sm mb-2">Notes</div>
        <div className="neumorphic-card px-4 py-4">
          {editing ? (
            <textarea
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              placeholder="Take with food, avoid grapefruit, etc."
              className="text-textPrimary bg-transparent outline-none w-full resize-none"
              rows={2}
            />
          ) : (
            <span className="text-textPrimary">{med.notes || "No notes"}</span>
          )}
        </div>
      </div>

      {editing ? (
        <button
          onClick={saveEdits}
          disabled={updateMed.isPending}
          className="brand-btn h-14 mt-2 disabled:opacity-60 tracking-wider font-bold"
        >
          {updateMed.isPending ? "Saving…" : "SAVE CHANGES"}
        </button>
      ) : (
        <>
          <div>
            <div className="text-textSecondary text-sm mb-2">Set stock count</div>
            <div className="neumorphic-card px-4 py-3 flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <StepperButton label="−" onClick={() => setPending((p) => Math.max(0, p - 1))} />
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={pending}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v >= 0) setPending(v);
                    }}
                    className="w-16 text-center font-bold text-lg text-textPrimary bg-transparent outline-none border-b-2 border-tealAccent"
                  />
                  <span className="text-textSecondary text-sm">pills</span>
                </div>
                <StepperButton label="+" onClick={() => setPending((p) => p + 1)} />
              </div>
              {/* Quick set buttons */}
              <div className="flex gap-2 justify-center">
                {[0, 10, 20, 30, 60, 90].map((v) => (
                  <button
                    key={v}
                    onClick={() => setPending(v)}
                    className={`text-xs px-3 py-1 rounded-full transition-colors ${
                      pending === v
                        ? "bg-forestGreen text-white"
                        : "bg-softSurfaceHighlight text-textSecondary hover:text-textPrimary"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={saveStock}
            disabled={setStock.isPending}
            className="brand-btn h-14 mt-2 disabled:opacity-60 tracking-wider font-bold"
          >
            SAVE
          </button>
        </>
      )}

      {/* Dose History */}
      {doseHistory && doseHistory.length > 0 && (
        <div>
          <div className="text-textSecondary text-sm mb-2">Recent Doses</div>
          <div className="neumorphic-card px-4 py-3 flex flex-col gap-2 max-h-48 overflow-y-auto">
            {doseHistory.map((log) => (
              <div key={log.id} className="flex justify-between items-center text-sm">
                <span className="text-textPrimary">
                  −{log.quantity} pill{log.quantity > 1 ? "s" : ""}
                </span>
                <span className="text-textSecondary">
                  {log.source === "hardware" ? "📦" : log.source === "simulated" ? "🧪" : "👤"}{" "}
                  {new Date(log.takenAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-softSurface rounded-2xl p-6 mx-4 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-textPrimary mb-2">Delete {med.name}?</h3>
            <p className="text-textSecondary text-sm mb-4">
              This will permanently remove this medication and all its dose history. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-3 rounded-xl neumorphic-card text-textPrimary font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={delMed.isPending}
                className="flex-1 py-3 rounded-xl bg-lowStockRed text-textOnGradient font-semibold disabled:opacity-60"
              >
                {delMed.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepperButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-10 h-10 rounded-xl flex items-center justify-center text-xl text-textOnGradient bg-tealAccent"
    >
      {label}
    </button>
  );
}
