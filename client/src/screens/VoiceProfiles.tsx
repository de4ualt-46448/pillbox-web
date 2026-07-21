import { useRef, useState } from "react";
import {
  useVoiceProfiles,
  useCreateLocalVoice,
  useCloneVoice,
  useRecordedVoice,
  useDeleteVoice,
  useSetDefaultVoice,
} from "../lib/queries";
import { speakLocal, speakCloned, playRecording, isSpeechSupported } from "../lib/tts";
import type { VoiceProfile } from "../types";

type VoiceMode = "LOCAL_TTS" | "CLONED_REMOTE" | "RECORDED";

/** Voice profile management — ports VoiceProfileScreen.kt + ViewModel. */
export function VoiceProfiles() {
  const { data: profiles = [] } = useVoiceProfiles();
  const addLocal = useCreateLocalVoice();
  const clone = useCloneVoice();
  const recorded = useRecordedVoice();
  const del = useDeleteVoice();
  const setDefault = useSetDefaultVoice();
  const [showSheet, setShowSheet] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [recordedError, setRecordedError] = useState("");

  return (
    <div className="flex flex-col gap-5 pt-2">
      <div>
        <h1 className="text-xl font-bold text-textPrimary">Voice Reminders</h1>
        <p className="text-textSecondary text-sm mt-1">
          Choose the voice (or your own recording) that plays for medication reminders.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {profiles.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            onSelect={() => setDefault.mutate(p.id)}
            onPreview={() => {
              if (p.engine === "RECORDED" && p.audioUrl) {
                playRecording(p.audioUrl).catch(() => {});
                return;
              }
              const text = "This is your medication reminder voice.";
              if (p.engine === "CLONED_REMOTE") {
                if (p.remoteVoiceId) speakCloned(text, p.remoteVoiceId).catch(() => speakLocal(text));
                else alert("Cloning still in progress…");
              } else {
                speakLocal(text, p.localeTag);
              }
            }}
            onDelete={() => del.mutate(p.id)}
          />
        ))}
        {profiles.length === 0 && (
          <div className="neumorphic-card p-6 text-center text-textSecondary">
            No voice profiles yet. Add a built-in voice or record your own.
          </div>
        )}
      </div>

      <button onClick={() => setShowSheet(true)} className="brand-btn h-14 mt-2">
        ＋ Add voice profile
      </button>

      {showSheet && (
        <AddSheet
          busy={addLocal.isPending || clone.isPending || recorded.isPending}
          error={cloneError || recordedError}
          onClose={() => setShowSheet(false)}
          onUseLocal={(name) => {
            addLocal.mutate({ displayName: name, localeTag: "en-US" });
            setShowSheet(false);
          }}
          onClone={(name, blob) => {
            setCloneError("");
            const form = new FormData();
            form.append("name", name);
            form.append("sample", blob, "sample.webm");
            clone.mutate(form, {
              onSuccess: () => setShowSheet(false),
              onError: (e) => setCloneError((e as Error).message || "Voice cloning failed."),
            });
          }}
          onRecord={(name, blob) => {
            setRecordedError("");
            const form = new FormData();
            form.append("name", name);
            form.append("sample", blob, "sample.webm");
            recorded.mutate(form, {
              onSuccess: () => setShowSheet(false),
              onError: (e) => setRecordedError((e as Error).message || "Could not save the recording."),
            });
          }}
        />
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  onSelect,
  onPreview,
  onDelete,
}: {
  profile: VoiceProfile;
  onSelect: () => void;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const subtitle =
    profile.engine === "LOCAL_TTS"
      ? "On-device voice"
      : profile.engine === "RECORDED"
        ? "Your recorded voice"
        : profile.remoteVoiceId
          ? "Cloned voice"
          : "Cloning in progress…";
  return (
    <>
      <div onClick={onSelect} className="neumorphic-card p-4 flex items-center gap-3 cursor-pointer">
        <div className="w-10 h-10 rounded-full bg-paleMint flex items-center justify-center">🎙️</div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-textPrimary truncate">{profile.displayName}</div>
          <div className="text-textSecondary text-sm truncate">{subtitle}</div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPreview();
          }}
          aria-label="Preview"
          className="text-tealAccent text-xl px-2"
        >
          ▶
        </button>
        {profile.isDefault && <span className="text-forestGreen text-xl">✓</span>}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowConfirm(true);
          }}
          aria-label="Delete"
          className="text-lowStockRed text-lg px-2"
        >
          🗑
        </button>
      </div>
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowConfirm(false)}>
          <div className="bg-softSurface rounded-2xl p-6 mx-4 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-textPrimary mb-2">Delete {profile.displayName}?</h3>
            <p className="text-textSecondary text-sm mb-4">This voice profile will be permanently removed.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-3 rounded-xl neumorphic-card text-textPrimary font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowConfirm(false); onDelete(); }}
                className="flex-1 py-3 rounded-xl bg-lowStockRed text-textOnGradient font-semibold"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AddSheet({
  busy,
  error,
  onClose,
  onUseLocal,
  onClone,
  onRecord,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onUseLocal: (name: string) => void;
  onClone: (name: string, blob: Blob) => void;
  onRecord: (name: string, blob: Blob) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<VoiceMode>("LOCAL_TTS");
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const chooseMode = (m: VoiceMode) => {
    setMode(m);
    setRecordedBlob(null);
    setPreviewing(false);
  };

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    chunksRef.current = [];
    rec.ondataavailable = (e) => chunksRef.current.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      setRecordedBlob(blob);
      setRecording(false);
      stream.getTracks().forEach((t) => t.stop());
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  const playPreview = () => {
    if (!recordedBlob) return;
    previewAudioRef.current?.pause();
    const a = new Audio(URL.createObjectURL(recordedBlob));
    previewAudioRef.current = a;
    a.onended = () => setPreviewing(false);
    a.play()
      .then(() => setPreviewing(true))
      .catch(() => setPreviewing(false));
  };

  const discardRecording = () => {
    previewAudioRef.current?.pause();
    setRecordedBlob(null);
    setPreviewing(false);
  };

  const saveRecording = () => {
    if (!recordedBlob) return;
    if (mode === "RECORDED") onRecord(name || "My Voice", recordedBlob);
    else onClone(name || "Cloned Voice", recordedBlob);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-20" onClick={onClose}>
      <div
        className="bg-softSurface w-full max-w-md rounded-t-3xl p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-textPrimary">New Voice Profile</h2>
        <label className="flex flex-col gap-1.5 mt-4">
          <span className="text-sm font-medium text-textPrimary">Name (e.g. "Mom's Voice")</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="neumorphic-inset px-4 py-3 outline-none"
          />
        </label>

        <div className="flex gap-2 mt-4">
          <button
            onClick={() => chooseMode("LOCAL_TTS")}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${
              mode === "LOCAL_TTS" ? "bg-brandGradient text-textOnGradient" : "neumorphic-card"
            }`}
          >
            Built-in
          </button>
          <button
            onClick={() => chooseMode("CLONED_REMOTE")}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${
              mode === "CLONED_REMOTE" ? "bg-brandGradient text-textOnGradient" : "neumorphic-card"
            }`}
          >
            Clone (ElevenLabs)
          </button>
          <button
            onClick={() => chooseMode("RECORDED")}
            className={`flex-1 py-2 rounded-xl text-sm font-semibold ${
              mode === "RECORDED" ? "bg-brandGradient text-textOnGradient" : "neumorphic-card"
            }`}
          >
            Record
          </button>
        </div>

        <div className="mt-5">
          {mode === "LOCAL_TTS" ? (
            <button
              disabled={!name.trim() || busy}
              onClick={() => onUseLocal(name || "Default Voice")}
              className="brand-btn w-full py-3 disabled:opacity-60"
            >
              Use built-in voice
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-textSecondary text-sm">
                {mode === "RECORDED"
                  ? "Record a short message (e.g. \"Time to take your medicine!\"). It replays as your reminder alarm — no extra service needed."
                  : "Record a clear ~30 second sample. It's uploaded to ElevenLabs to clone your voice (requires an ElevenLabs plan with instant voice cloning)."}
              </p>
              {!isSpeechSupported() && mode !== "RECORDED" && (
                <p className="text-warningAmber text-xs">Note: local preview TTS may be unavailable in this browser.</p>
              )}
              {error && (
                <div className="rounded-xl bg-progressLow text-textOnGradient px-3 py-2 text-xs leading-relaxed">
                  {error}
                  {error.includes("create_instant_voice_clone") && (
                    <span>
                      {" "}
                      Your ElevenLabs plan doesn't include instant voice cloning — upgrade or enable it in your
                      ElevenLabs dashboard. Use "Record" instead to replay your own voice.
                    </span>
                  )}
                </div>
              )}
              <button
                disabled={!name.trim() || busy}
                onClick={startRecording}
                className="w-full py-3 rounded-full font-semibold text-textOnGradient bg-forestGreen disabled:opacity-60"
              >
                Start Recording
              </button>
              {recording && (
                <button
                  onClick={stopRecording}
                  className="w-full py-3 rounded-full font-semibold text-textOnGradient bg-lowStockRed"
                >
                  Stop
                </button>
              )}
              {recordedBlob && !recording && (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <button
                      onClick={playPreview}
                      disabled={busy}
                      className="flex-1 py-3 rounded-full font-semibold text-textOnGradient bg-tealAccent disabled:opacity-60"
                    >
                      {previewing ? "▶ Playing…" : "▶ Preview"}
                    </button>
                    <button
                      onClick={discardRecording}
                      disabled={busy}
                      className="flex-1 py-3 rounded-full font-semibold neumorphic-card disabled:opacity-60"
                    >
                      Re-record
                    </button>
                  </div>
                  <button
                    onClick={saveRecording}
                    disabled={!name.trim() || busy}
                    className="brand-btn w-full py-3 disabled:opacity-60"
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
