import { useEffect, useRef, useState } from "react";
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
    confidence?: Record<string, number | null>;
  };
  status?: "complete" | "needs_review";
  warnings?: string[];
  provider?: string;
}

const MAX_IMAGE_DIMENSION = 2400;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose a JPEG, PNG, or WebP image.");
  }

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("The selected image could not be read."));
      element.src = sourceUrl;
    });

    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(longestSide, 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    if (scale === 1 && file.size <= MAX_UPLOAD_BYTES && file.type === "image/jpeg") {
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });
    if (!blob) return file;
    return new File([blob], "pillbox-scan.jpg", { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function friendlyScanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Scan failed. Please try again.";
  if (message.includes("OCR is not configured")) {
    return "Medication scanning is not configured on the server yet. Please contact the administrator to add an OCR provider key.";
  }
  if (message.includes("could not process this image")) {
    return "The image could not be read. Try a brighter, sharper photo with the label filling the frame.";
  }
  return message;
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

  useEffect(() => {
    if (!cameraOpen || !stream || !videoRef.current) return;
    const video = videoRef.current;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [cameraOpen, stream]);

  useEffect(() => () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (preview) URL.revokeObjectURL(preview);
  }, [preview, stream]);

  const openCamera = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera capture is not available in this browser. Please choose an image instead.");
      return;
    }
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      setStream(mediaStream);
      setCameraOpen(true);
    } catch {
      setError("Camera access was denied. Please allow camera permission or use Choose Image.");
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video.videoWidth || !video.videoHeight) {
      setError("The camera is still focusing. Please wait a moment and try again.");
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("Could not capture the camera frame. Please choose an image instead.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) {
        void handleFile(new File([blob], "camera-scan.jpg", { type: "image/jpeg" }));
        closeCamera();
      } else {
        setError("Could not capture the camera frame. Please try again.");
      }
    }, "image/jpeg", 0.94);
  };

  const closeCamera = () => {
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setCameraOpen(false);
  };

  const handleFile = async (file: File) => {
    setError("");
    setLoading(true);
    try {
      const prepared = await prepareImage(file);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(prepared));

      const form = new FormData();
      form.append("image", prepared, prepared.name);
      form.append("mode", mode);
      const result = await api.upload<ScanResult>("/scan/ocr", form);
      navigate("/scan-review", {
        state: {
          rawText: result.rawText,
          mode,
          parsed: result.parsed,
          warnings: result.warnings ?? [],
          status: result.status,
          provider: result.provider,
        },
      });
    } catch (scanError) {
      setError(friendlyScanError(scanError));
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleFile(file);
    event.target.value = "";
  };

  if (cameraOpen) {
    return (
      <div className="flex flex-col gap-4 pt-2">
        <div className="relative overflow-hidden rounded-2xl neumorphic-card bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full object-cover"
            style={{ maxHeight: "60vh" }}
          />
          <div className="pointer-events-none absolute inset-5 rounded-xl border-2 border-white/70" />
          <p className="pointer-events-none absolute left-4 right-4 top-4 rounded-xl bg-black/60 px-3 py-2 text-center text-xs font-medium text-white">
            Fit the label inside the frame. Hold still, avoid glare, and use bright even light.
          </p>
        </div>
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

  return (
    <div className="flex flex-col gap-5 pt-2">
      <h1 className="text-xl font-bold text-textPrimary">Scan Medication</h1>

      <div className="flex gap-2">
        {(["label", "prescription"] as const).map((scanMode) => (
          <button
            key={scanMode}
            onClick={() => setMode(scanMode)}
            className={`flex-1 py-3 rounded-2xl font-semibold text-sm transition ${
              mode === scanMode ? "bg-forestGreen text-white" : "neumorphic-card text-textSecondary"
            }`}
          >
            {scanMode === "label" ? "Pill Box Label" : "Prescription"}
          </button>
        ))}
      </div>

      <div className="rounded-2xl bg-paleMint/40 px-4 py-3 text-sm text-textPrimary">
        {mode === "label"
          ? "Use a sharp, close photo of one box or bottle. Keep the medicine name and strength visible."
          : "Place one prescription flat in bright light. Capture the full page, then verify every field before saving."}
      </div>

      {preview && (
        <div className="rounded-2xl overflow-hidden neumorphic-card">
          <img src={preview} alt="Scanned medication" className="w-full max-h-64 object-contain" />
        </div>
      )}

      {error && <p className="text-lowStockRed text-sm">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={() => void openCamera()}
          disabled={loading}
          className="brand-btn flex-1 py-3 font-semibold disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {loading ? <span className="animate-spin">⏳</span> : <span>📷</span>}
          {loading ? "Reading…" : "Take Photo"}
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          className="neumorphic-card flex-1 py-3 font-semibold text-textPrimary disabled:opacity-60 flex items-center justify-center gap-2"
        >
          <span>🖼️</span> Choose Image
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleInputChange}
      />
    </div>
  );
}
