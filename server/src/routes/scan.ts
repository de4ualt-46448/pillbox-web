import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth.js";
import {
  GROQ_API_KEY,
  GROQ_BASE_URL,
  GROQ_OCR_MODEL,
  NVIDIA_API_KEY,
  NVIDIA_BASE_URL,
  NVIDIA_OCR_MODEL,
  OCR_PROVIDER,
  OCR_TIMEOUT_MS,
  OPENAI_API_KEY,
  OPENAI_OCR_MODEL,
} from "../config.js";

export const scanRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

scanRouter.use(requireAuth);

type Provider = "nvidia" | "openai" | "groq";
type ScanMode = "label" | "prescription";

type Confidence = {
  name: number | null;
  dosage: number | null;
  frequency: number | null;
  totalQuantity: number | null;
  quantityPerDose: number | null;
};

type ParsedMedication = {
  name: string | null;
  dosage: string | null;
  frequency: string | null;
  timesOfDay: string[];
  totalQuantity: number | null;
  quantityPerDose: number | null;
  confidence: Confidence;
};

type ScanResult = {
  rawText: string;
  parsed: ParsedMedication;
  provider: Provider;
  status: "complete" | "needs_review";
  warnings: string[];
};

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "qwen/qwen3.6-27b";

const OCR_PROMPT = `You are a high-accuracy OCR and medication-data extraction engine for a medication app used in Egypt. The image is a ${"{{MODE}}"}.

Read every visible character before extracting fields. The image may contain Arabic handwriting, Arabic pharmacy printing, Arabic-Indic numerals, and a brand or generic name in Latin, English, or French. Never ignore Arabic text. If text is blurry or ambiguous, preserve the best transcription but set the affected field to null and add a warning instead of guessing.

Return ONLY one valid JSON object with exactly these keys:
{
  "name": string|null,
  "dosage": string|null,
  "frequency": string|null,
  "timesOfDay": string[],
  "totalQuantity": number|null,
  "quantityPerDose": number|null,
  "rawText": string,
  "confidence": {
    "name": number|null,
    "dosage": number|null,
    "frequency": number|null,
    "totalQuantity": number|null,
    "quantityPerDose": number|null
  },
  "warnings": string[]
}

Extraction rules:
- rawText must be a faithful transcription of all readable Arabic and Latin text, in reading order.
- Convert Arabic-Indic digits ٠١٢٣٤٥٦٧٨٩ to Western digits 0123456789 in every output string.
- Keep the medication brand/generic name as printed. Do not translate or substitute a familiar medicine name.
- Translate clear Arabic schedule phrases into frequency: مرة يوميا/مرة واحدة يوميا = Once daily; مرتين يوميا = Twice daily; 3 مرات يوميا/تلات مرات باليوم = Three times daily; كل 8 ساعات = Every 8 hours; عند اللزوم = As needed.
- Recognize common terms such as قرص/أقراص (tablet), كبسولة (capsule), ملعقة (spoon), and شراب (syrup), but do not infer a dosage amount that is not visible.
- timesOfDay may contain only explicit times visible in the image, normalized to 24-hour HH:mm. If only a frequency is present, return []. Never invent clock times.
- Numeric fields must be numbers, not strings, and must be null when unreadable.
- Confidence values must be between 0 and 1, or null when the field is absent. Keep confidence low for handwriting, blur, glare, or partial text.
- warnings should describe ambiguity, blur, glare, cropped text, or fields that need user verification.
- Do not include markdown, code fences, commentary, or any keys other than those listed.`;

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function configuredProviders(): Provider[] {
  const available: Provider[] = [];
  // Qwen 3.6 is the preferred path for Arabic/English OCR; retain the configured fallbacks.
  if (GROQ_API_KEY) available.push("groq");
  if (NVIDIA_API_KEY) available.push("nvidia");
  if (OPENAI_API_KEY) available.push("openai");

  if (OCR_PROVIDER === "auto") return available;
  return available.includes(OCR_PROVIDER) ? [OCR_PROVIDER] : [];
}

function configuredProviderNames(): string[] {
  return configuredProviders();
}

export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = normalizeDigits(value).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function cleanNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = normalizeDigits(value).replace(/[^0-9.+-]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeDigits(value).trim().replace(/[.،]/g, ":");
  const match = normalized.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function cleanConfidence(value: unknown): number | null {
  const parsed = cleanNumber(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(1, parsed));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part as { text?: unknown })?.text))
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  return "";
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

export function parseOcrResponse(text: string, provider: Provider): ScanResult {
  const object = extractJson(text);
  const rawText = cleanString(object?.rawText) ?? normalizeDigits(text.trim());
  const sourceWarnings = Array.isArray(object?.warnings)
    ? object.warnings.map(cleanString).filter((warning): warning is string => Boolean(warning))
    : [];
  const confidence = (object?.confidence && typeof object.confidence === "object")
    ? object.confidence as Record<string, unknown>
    : {};

  const times = Array.isArray(object?.timesOfDay)
    ? object.timesOfDay.map(cleanTime).filter((time): time is string => Boolean(time))
    : [];
  const parsed: ParsedMedication = {
    name: cleanString(object?.name),
    dosage: cleanString(object?.dosage),
    frequency: cleanString(object?.frequency),
    timesOfDay: [...new Set(times)],
    totalQuantity: cleanNumber(object?.totalQuantity),
    quantityPerDose: cleanNumber(object?.quantityPerDose),
    confidence: {
      name: cleanConfidence(confidence.name),
      dosage: cleanConfidence(confidence.dosage),
      frequency: cleanConfidence(confidence.frequency),
      totalQuantity: cleanConfidence(confidence.totalQuantity),
      quantityPerDose: cleanConfidence(confidence.quantityPerDose),
    },
  };

  const warnings = [...sourceWarnings];
  if (!object) warnings.push("The OCR provider did not return valid structured data. Please verify every field.");
  if (!parsed.name) warnings.push("Medication name was not confidently recognized.");
  const confidenceWarnings: Array<[keyof Confidence, string, string | null]> = [
    ["name", "Medication name", parsed.name],
    ["dosage", "Dosage", parsed.dosage],
    ["frequency", "Frequency", parsed.frequency],
    ["totalQuantity", "Total quantity", parsed.totalQuantity === null ? null : String(parsed.totalQuantity)],
    ["quantityPerDose", "Pills per dose", parsed.quantityPerDose === null ? null : String(parsed.quantityPerDose)],
  ];
  for (const [key, label, value] of confidenceWarnings) {
    if (value && parsed.confidence[key] !== null && parsed.confidence[key] !== undefined && parsed.confidence[key]! < 0.7) {
      warnings.push(`${label} may be uncertain.`);
    }
  }
  if (!rawText) warnings.push("No readable text was found. Try a sharper, brighter photo.");

  return {
    rawText,
    parsed,
    provider,
    status: warnings.length === 0 && Boolean(parsed.name) ? "complete" : "needs_review",
    warnings: [...new Set(warnings)],
  };
}

function imageMessage(imageDataUrl: string): { type: "image_url"; image_url: { url: string; detail?: string } } {
  return { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } };
}

async function callProvider(provider: Provider, imageDataUrl: string, mode: ScanMode): Promise<ScanResult> {
  const prompt = OCR_PROMPT.replace("{{MODE}}", mode === "prescription" ? "doctor's prescription" : "medication box or bottle label");
  const messages = [{
    role: "user",
    content: [{ type: "text", text: prompt }, imageMessage(imageDataUrl)],
  }];

  let url: string;
  let body: Record<string, unknown>;
  let apiKey: string;

  if (provider === "nvidia") {
    url = endpoint(NVIDIA_BASE_URL);
    apiKey = NVIDIA_API_KEY;
    body = { model: NVIDIA_OCR_MODEL, messages, max_tokens: 1800, temperature: 0, top_p: 0.1, stream: false };
  } else if (provider === "openai") {
    url = OPENAI_URL;
    apiKey = OPENAI_API_KEY;
    body = { model: OPENAI_OCR_MODEL, messages, max_tokens: 1800, temperature: 0, response_format: { type: "json_object" } };
  } else {
    url = endpoint(GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL);
    apiKey = GROQ_API_KEY;
    body = {
      model: GROQ_OCR_MODEL || DEFAULT_GROQ_MODEL,
      messages,
      max_completion_tokens: 1800,
      temperature: 0.1,
      reasoning_effort: "none",
      stream: false,
      response_format: { type: "json_object" },
    };
  }

  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });

  if (!response.ok) {
    const providerBody = await response.text().catch(() => "");
    throw new Error(`${provider} returned HTTP ${response.status}: ${providerBody.slice(0, 400)}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = contentToText(data.choices?.[0]?.message?.content);
  if (!text) throw new Error(`${provider} returned an empty OCR response`);
  const result = parseOcrResponse(text, provider);
  console.log(`[scan] ${provider} OCR ${result.status} in ${Date.now() - startedAt}ms`);
  return result;
}

function imageFromRequest(req: { file?: Express.Multer.File; body?: Record<string, unknown> }): string | null {
  if (req.file) {
    if (!req.file.mimetype.startsWith("image/")) return null;
    return `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
  }
  if (typeof req.body?.dataUrl === "string") return req.body.dataUrl;
  if (typeof req.body?.image === "string") {
    return req.body.image.startsWith("data:") || req.body.image.startsWith("http")
      ? req.body.image
      : `data:image/jpeg;base64,${req.body.image}`;
  }
  return null;
}

scanRouter.post("/ocr", upload.single("image"), async (req, res) => {
  const imageDataUrl = imageFromRequest(req);
  if (!imageDataUrl) {
    res.status(400).json({ code: "OCR_IMAGE_INVALID", error: "Please upload a valid image file." });
    return;
  }

  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(imageDataUrl) && !/^https?:\/\//i.test(imageDataUrl)) {
    res.status(400).json({ code: "OCR_IMAGE_INVALID", error: "Only JPEG, PNG, or WebP images are supported." });
    return;
  }

  if (imageDataUrl.length > 24 * 1024 * 1024) {
    res.status(413).json({ code: "OCR_IMAGE_TOO_LARGE", error: "Image is too large. Choose a smaller photo and try again." });
    return;
  }

  const mode: ScanMode = req.body?.mode === "prescription" ? "prescription" : "label";
  const providers = configuredProviders();
  console.log(`[scan] ${mode} image received (${Math.round(imageDataUrl.length / 1024)}KB), providers=${providers.join(",") || "none"}`);

  if (providers.length === 0) {
    const configuredFor = OCR_PROVIDER === "auto"
      ? "NVIDIA_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY"
      : `${OCR_PROVIDER === "nvidia" ? "NVIDIA" : OCR_PROVIDER.toUpperCase()}_API_KEY`;
    res.status(503).json({
      code: "OCR_NOT_CONFIGURED",
      error: `OCR is not configured on the server. Add ${configuredFor} to the Railway web service environment variables.`,
      providers: configuredProviderNames(),
    });
    return;
  }

  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const result = await callProvider(provider, imageDataUrl, mode);
      res.json(result);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown provider error";
      failures.push(`${provider}: ${message}`);
      console.error(`[scan] ${provider} failed: ${message}`);
    }
  }

  res.status(502).json({
    code: "OCR_PROVIDER_FAILED",
    error: "The OCR service could not process this image. Try a sharper photo or try again shortly.",
    providersTried: providers,
  });
});
