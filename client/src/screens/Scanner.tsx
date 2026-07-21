import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import Webcam from "react-webcam";
import { createWorker, type Worker } from "tesseract.js";
import { api } from "../lib/api";
import { parsePrescription } from "../lib/prescriptionParser";
import type { ParsedMedication } from "../types";

type ScanMode = "label" | "prescription";

interface ScanResult {
  rawText: string;
  parsed: ParsedMedication;
}

const MAX_ATTEMPTS = 5;

/**
 * Camera scanner for prescriptions & pill labels.
 * Uses Groq vision API (server-side) for best accuracy.
 * Falls back to Tesseract.js (local) if the API is unavailable.
 *
 * Auto-stops after MAX_ATTEMPTS frames or when text is stable.
 * User can also tap "Done" to stop manually.
 */
export function Scanner() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialMode = ((location.state as { mode?: ScanMode } | null)?.mode ?? "label") as ScanMode;

  const webcamRef = useRef<Webcam>(null);
  const tesseractRef = useRef<Worker | null>(null);
  const busyRef = useRef(false);
  const pausedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attemptsRef = useRef(0);
  const bestScanRef = useRef<ScanResult | null>(null);

  const [mode, setMode] = useState<ScanMode>(initialMode);
  const [status, setStatus] = useState<"loading" | "scanning" | "reading" | "error" | "done">("loading");
  const [message, setMessage] = useState("");
  const [liveText, setLiveText] = useState("");
  const [attemptCount, setAttemptCount] = useState(0);

  // Initialize Tesseract as fallback
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const worker = await createWorker("eng", 1, { logger: () => {} });
        if (!cancelled) {
          tesseractRef.current = worker;
          setStatus("scanning");
        }
      } catch {
        if (!cancelled) setStatus("scanning");
      }
    })();
    return () => {
      cancelled = true;
      tesseractRef.current?.terminate();
    };
  }, []);

  // Try Groq API first, fall back to Tesseract
  const runOcr = useCallback(async (dataUrl: string): Promise<ScanResult> => {
    try {
      const res = await api.post<{ rawText: string; parsed: ParsedMedication }>("/scan/ocr", { dataUrl });
      if (res.rawText || res.parsed?.name) {
        return { rawText: res.rawText || "", parsed: res.parsed || parsePrescription(res.rawText || "") };
      }
    } catch (e) {
      console.log("[Scanner] Groq unavailable, using Tesseract:", (e as Error).message);
    }

    if (tesseractRef.current) {
      const { data } = await tesseractRef.current.recognize(dataUrl);
      const rawText = data.text.trim();
      return { rawText, parsed: parsePrescription(rawText) };
    }

    throw new Error("No OCR engine available");
  }, []);

  function navigateToReview(scan: ScanResult) {
    pausedRef.current = true;
    setStatus("done");
    navigate("/scan-review", {
      state: { rawText: scan.rawText, mode, parsed: scan.parsed },
    });
  }

  // Pick the best scan from all attempts
  function pickBestScan(): ScanResult | null {
    return bestScanRef.current;
  }

  // Live scan loop — max MAX_ATTEMPTS frames, then auto-navigate
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (cancelled || pausedRef.current || busyRef.current) return;
      if (attemptsRef.current >= MAX_ATTEMPTS) {
        const best = pickBestScan();
        if (best) navigateToReview(best);
        return;
      }
      const webcam = webcamRef.current;
      if (!webcam) { schedule(); return; }
      const shot = webcam.getScreenshot();
      if (!shot) { schedule(); return; }

      busyRef.current = true;
      setStatus("reading");
      let errored = false;
      try {
        const scan = await runOcr(shot);
        if (cancelled) return;

        attemptsRef.current += 1;
        setAttemptCount(attemptsRef.current);

        const text = scan.rawText || "";
        setLiveText(text || scan.parsed.name || "");

        // Track best scan (most text extracted)
        if (text.length > (bestScanRef.current?.rawText?.length ?? 0)) {
          bestScanRef.current = scan;
        }

        // Auto-navigate if we found a medication name
        if (scan.parsed.name && scan.parsed.name.length > 2) {
          navigateToReview(scan);
          return;
        }

        // Auto-navigate after max attempts
        if (attemptsRef.current >= MAX_ATTEMPTS) {
          const best = pickBestScan();
          if (best) navigateToReview(best);
          return;
        }
      } catch (e) {
        errored = true;
        // Don't show error for live scan, just skip
        attemptsRef.current += 1;
        setAttemptCount(attemptsRef.current);
      } finally {
        busyRef.current = false;
        if (!cancelled && !errored) schedule();
      }
    }

    function schedule() {
      timer = setTimeout(tick, 2500);
    }

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runOcr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function recognizeImage(dataUrl: string) {
    pausedRef.current = true;
    busyRef.current = true;
    setStatus("reading");
    setMessage("");
    try {
      const scan = await runOcr(dataUrl);
      setLiveText(scan.rawText || scan.parsed.name || "");
      navigateToReview(scan);
    } catch (e) {
      setStatus("error");
      setMessage((e as Error).message || "OCR failed on this image.");
    } finally {
      busyRef.current = false;
      pausedRef.current = false;
    }
  }

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error || new Error("Could not read the file."));
      r.readAsDataURL(file);
    });
  }

  return (
    <div className="flex flex-col gap-3 pt-2">
      {/* Mode toggle */}
      <div className="flex gap-2">
        <ModeButton active={mode === "label"} onClick={() => setMode("label")} label="Bottle label" />
        <ModeButton active={mode === "prescription"} onClick={() => setMode("prescription")} label="Prescription" />
      </div>
      <p className="text-xs text-textSecondary leading-relaxed">
        {mode === "prescription"
          ? "Scan a prescription — we'll read the times and add reminder timers automatically."
          : "Scan a pill-bottle label to save it to your inventory."}
        <span className="ml-1 inline-flex items-center gap-1 text-forestGreen font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-forestGreen" /> AI Vision OCR
        </span>
      </p>

      <div className="relative h-[52vh] rounded-3xl overflow-hidden bg-black">
        <Webcam
          ref={webcamRef}
          audio={false}
          screenshotFormat="image/jpeg"
          className="w-full h-full object-cover"
          videoConstraints={{ facingMode: "environment" }}
        />

        <button
          onClick={() => navigate(-1)}
          aria-label="Close scanner"
          className="absolute top-4 left-4 w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/60 transition-colors"
        >
          ✕
        </button>

        {/* Status badge */}
        {status === "reading" && (
          <div className="absolute top-4 right-4 bg-black/50 text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-forestGreen animate-pulse" />
            Reading… ({attemptCount}/{MAX_ATTEMPTS})
          </div>
        )}

        {status === "loading" && (
          <div className="absolute top-4 right-4 bg-black/50 text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-warningAmber animate-pulse" />
            Loading OCR…
          </div>
        )}

        {status === "done" && (
          <div className="absolute top-4 right-4 bg-forestGreen/80 text-white text-xs px-3 py-1.5 rounded-full flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white" />
            Found!
          </div>
        )}

        {/* Scan guide frame */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-52 h-52 border-2 border-white/50 rounded-2xl" />
        </div>

        <div className="absolute bottom-4 left-0 right-0 flex flex-col items-center gap-2 text-white px-6">
          {status === "error" && (
            <p className="text-center text-sm bg-lowStockRed/90 px-3 py-1.5 rounded-xl">{message}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => {
                const shot = webcamRef.current?.getScreenshot();
                if (shot) recognizeImage(shot);
              }}
              disabled={status === "loading"}
              className="brand-btn px-6 py-2.5 disabled:opacity-50"
            >
              Capture manually
            </button>
            {status === "scanning" && (
              <button
                onClick={() => {
                  const best = pickBestScan();
                  if (best) navigateToReview(best);
                  else {
                    setStatus("error");
                    setMessage("No text detected yet. Try capturing manually.");
                  }
                }}
                className="neumorphic-card px-5 py-2 text-textPrimary text-sm"
              >
                Done scanning
              </button>
            )}
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-white/70 text-xs underline"
          >
            Or upload a photo
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                try {
                  const dataUrl = await fileToDataUrl(f);
                  recognizeImage(dataUrl);
                } catch (err) {
                  setStatus("error");
                  setMessage((err as Error).message || "Could not read that file.");
                }
              }
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* Live OCR readout */}
      <div className="neumorphic-card p-3 min-h-[60px]">
        <div className="text-xs font-semibold text-textSecondary mb-1">Live scan</div>
        {liveText ? (
          <p className="text-sm text-textPrimary whitespace-pre-wrap break-words">{liveText}</p>
        ) : (
          <p className="text-sm text-textSecondary">
            {status === "loading" && "Loading OCR engine…"}
            {status === "scanning" && "Point camera at label… or tap Capture"}
            {status === "reading" && "AI reading text…"}
            {status === "error" && message}
            {status === "done" && "Text found! Opening review…"}
          </p>
        )}
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${
        active ? "bg-brandGradient text-textOnGradient shadow-sm" : "neumorphic-card text-textPrimary"
      }`}
    >
      {label}
    </button>
  );
}
