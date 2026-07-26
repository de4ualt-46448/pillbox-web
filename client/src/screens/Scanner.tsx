import { useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";

type ScanMode = "label" | "prescription";

interface ScanResult {
  rawText: string;
  parsed: {
    name: string | null;
    dosage: string | null;
    frequency: string | null;
    timesOfDay: string[];
    totalQuantity: number | null;
    quantityPerDose: number | null;
  };
}

export function Scanner() {
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const prevMode = (location.state as { mode?: ScanMode } | null)?.mode;
  const [mode, setMode] = useState<ScanMode>(prevMode ?? "label");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const openCamera = async () => {
    setError("");
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      setStream(mediaStream);
      setCameraOpen(true);
      // Attach to video element after render
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          videoRef.current.play();
        }
      }, 100);
    } catch (e) {
      setError("Camera access denied. Please allow camera permission or use Choose Image.");
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], "scan.jpg", { type: "image/jpeg" });
        handleFile(file);
      }
      closeCamera();
    }, "image/jpeg", 0.92);
  };

  const closeCamera = () => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    setCameraOpen(false);
  };

  const handleFile = async (file: File) => {
    setError("");
    setPreview(URL.createObjectURL(file));
    setLoading(true);

    try {
      const result = await api.upload<ScanResult>("/scan/ocr", (() => {
        const fd = new FormData();
        fd.append("image", file);
        return fd;
      })());
      navigate("/scan-review", {
        state: { rawText: result.rawText, mode, parsed: result.parsed },
      });
    } catch (e) {
      setError((e as Error).message || "Scan failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // Camera view
  if (cameraOpen) {
    return (
      <div className="flex flex-col gap-4 pt-2">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full rounded-2xl neumorphic-card object-cover"
          style={{ maxHeight: "60vh" }}
        />
        <canvas ref={canvasRef} className="hidden" />
        <div className="flex gap-3">
          <button
            onClick={capturePhoto}
            className="brand-btn flex-1 py-3 font-semibold flex items-center justify-center gap-2"
          >
            <span>📸</span> Capture
          </button>
          <button
            onClick={closeCamera}
            className="neumorphic-card flex-1 py-3 font-semibold text-textPrimary flex items-center justify-center gap-2"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Main scanner view
  return (
    <div className="flex flex-col gap-5 pt-2">
      <h1 className="text-xl font-bold text-textPrimary">Scan Medication</h1>

      {/* Mode toggle */}
      <div className="flex gap-2">
        {(["label", "prescription"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-3 rounded-2xl font-semibold text-sm transition ${
              mode === m
                ? "bg-forestGreen text-white"
                : "neumorphic-card text-textSecondary"
            }`}
          >
            {m === "label" ? "Pill Box Label" : "Prescription"}
          </button>
        ))}
      </div>

      <p className="text-textSecondary text-sm">
        {mode === "label"
          ? "Snap a photo of the medication box or bottle label."
          : "Snap a photo of the doctor's prescription (rosheta)."}
      </p>

      {/* Image preview */}
      {preview && (
        <div className="rounded-2xl overflow-hidden neumorphic-card">
          <img src={preview} alt="Scanned" className="w-full max-h-64 object-contain" />
        </div>
      )}

      {/* Error */}
      {error && <p className="text-lowStockRed text-sm">{error}</p>}

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={openCamera}
          disabled={loading}
          className="brand-btn flex-1 py-3 font-semibold disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {loading ? (
            <span className="animate-spin">⏳</span>
          ) : (
            <span>📷</span>
          )}
          {loading ? "Scanning…" : "Take Photo"}
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          className="neumorphic-card flex-1 py-3 font-semibold text-textPrimary disabled:opacity-60 flex items-center justify-center gap-2"
        >
          <span>🖼️</span>
          Choose Image
        </button>
      </div>

      {/* Hidden file input for gallery */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleInputChange}
      />
    </div>
  );
}
