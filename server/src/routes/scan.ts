import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth.js";
import { GEMINI_API_KEY, GROQ_API_KEY } from "../config.js";

export const scanRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

scanRouter.use(requireAuth);

/**
 * Scanner endpoint. Tries Gemini (primary) then Groq (fallback).
 * POST /api/scan/ocr
 *  JSON body: { "dataUrl": "data:image/jpeg;base64,..." }
 * Response: { rawText, parsed: { name, dosage, frequency, timesOfDay, totalQuantity, quantityPerDose } }
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const SCAN_PROMPT = `You are an OCR engine for a medication app. You are given a photo of either a pill-bottle label or a printed prescription. Extract the following details.

Return ONLY a JSON object with these exact keys (no markdown, no backticks, no commentary). Use null for any field you cannot determine.
{
  "name": string|null,
  "dosage": string|null,
  "frequency": string|null,
  "timesOfDay": string[],
  "totalQuantity": number|null,
  "quantityPerDose": number|null,
  "rawText": string
}

Rules:
- Times must be 24-hour HH:mm format (zero-padded). If the image says "twice daily" without times, output [].
- Do not invent data not present on the image. Use null / [] when uncertain.
- Output JSON only, parseable by JSON.parse.`;

function parseOcrResponse(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {
      name: null, dosage: null, frequency: null,
      timesOfDay: [], totalQuantity: null, quantityPerDose: null,
      rawText: cleaned,
    };
  }
  const rawText = parsed?.rawText ?? (typeof parsed === "object" && parsed !== null && "name" in parsed ? cleaned : "") ?? "";
  return { rawText, parsed };
}

// --- Gemini API (primary) ---
async function callGemini(imageDataUrl: string): Promise<{ rawText: string; parsed: any }> {
  const url = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
  console.log(`[scan] calling Gemini: gemini-2.0-flash`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: SCAN_PROMPT },
          { inlineData: { mimeType: "image/jpeg", data: imageDataUrl.split(",")[1] || imageDataUrl } },
        ],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1200 },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gemini failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = await res.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  console.log(`[scan] Gemini success, length: ${text.length}`);
  return parseOcrResponse(text);
}

// --- Groq API (fallback) ---
async function callGroq(imageDataUrl: string): Promise<{ rawText: string; parsed: any }> {
  console.log(`[scan] calling Groq: ${GROQ_MODEL}`);

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: SCAN_PROMPT },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      }],
      max_tokens: 1200,
      temperature: 0.1,
      stream: false,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Groq failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content ?? "";
  console.log(`[scan] Groq success, length: ${text.length}`);
  return parseOcrResponse(text);
}

scanRouter.post("/ocr", upload.single("image"), async (req, res) => {
  let imageDataUrl: string | null = null;

  if (req.file) {
    const mime = req.file.mimetype || "image/jpeg";
    imageDataUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  } else if (typeof req.body?.dataUrl === "string") {
    imageDataUrl = req.body.dataUrl;
  } else if (typeof req.body?.image === "string") {
    imageDataUrl = req.body.image.startsWith("data:") || req.body.image.startsWith("http")
      ? req.body.image
      : `data:image/jpeg;base64,${req.body.image}`;
  }

  if (!imageDataUrl) {
    res.status(400).json({ error: "No image supplied." });
    return;
  }

  console.log(`[scan] image size: ${Math.round(imageDataUrl.length / 1024)}KB`);

  // Try Gemini first, then Groq
  if (GEMINI_API_KEY) {
    try {
      const result = await callGemini(imageDataUrl);
      res.json(result);
      return;
    } catch (e: any) {
      console.error(`[scan] Gemini failed: ${e.message}, trying Groq...`);
    }
  }

  if (GROQ_API_KEY) {
    try {
      const result = await callGroq(imageDataUrl);
      res.json(result);
      return;
    } catch (e: any) {
      console.error(`[scan] Groq failed: ${e.message}`);
      res.status(502).json({ error: `All OCR providers failed. Last error: ${e.message}` });
      return;
    }
  }

  res.status(503).json({ error: "No OCR API key configured. Set GEMINI_API_KEY or GROQ_API_KEY." });
});
