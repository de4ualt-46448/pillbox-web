import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../auth.js";
import { OPENAI_API_KEY, GROQ_API_KEY } from "../config.js";

export const scanRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

scanRouter.use(requireAuth);

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "qwen/qwen3.6-27b";

const SCAN_PROMPT = `You are an OCR engine for a medication app used in Egypt. You are given a photo of either a pill-bottle/box label or a printed or handwritten prescription ("rosheta" / روشتة from an Egyptian doctor or pharmacy). Extract the following details.

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

Important context — these images are frequently:
- Written mostly in Arabic (doctor's handwriting or a pharmacy-printed label), with the drug's brand name in Latin/French/English script (e.g. "Augmentin", "Panadol").
- Using Arabic medical shorthand for frequency/dosage instead of English, such as:
  "مرة يوميا" / "مرة واحدة يوميا" = once daily, "مرتين يوميا" = twice daily,
  "3 مرات يوميا" / "تلات مرات باليوم" = three times daily,
  "كل 8 ساعات" / "كل ٨ ساعات" = every 8 hours, "عند اللزوم" = as needed,
  "قرص" / "أقراص" = tablet(s), "كبسولة" = capsule, "ملعقة" = spoon/teaspoon (for syrups).
- Using Arabic-Indic numerals (٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩) instead of, or mixed with, Western numerals (0-9).

Rules:
- Read Arabic text natively — do not skip or ignore it because it isn't Latin script.
- Translate any Arabic frequency/dosage phrasing into the English "frequency" field (e.g. "مرتين يوميا" -> "Twice daily", "كل 8 ساعات" -> "Every 8 hours").
- Convert any Arabic-Indic numerals you read into standard Western numerals (٨ -> 8) everywhere in the output, including inside "rawText".
- Keep the medication's brand/generic "name" exactly as printed (usually Latin script), even if the rest of the label is Arabic.
- Times must be 24-hour HH:mm format (zero-padded). If the image only gives a frequency like "twice daily" with no explicit clock times, output [] for timesOfDay — do not guess clock times.
- Do not invent data not present on the image. Use null / [] when uncertain.
- "rawText" should be your best full transcription of everything on the image (Arabic and Latin), with numerals normalized as above.
- Output JSON only, parseable by JSON.parse.`;

function parseOcrResponse(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: any = null;

  // 1. Try direct parse
  try { parsed = JSON.parse(cleaned); } catch {}

  // 2. Try to extract a JSON object from surrounding text
  if (!parsed) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
  }

  // 3. Last resort: all nulls, rawText = the full text
  if (!parsed || typeof parsed !== "object") {
    parsed = {
      name: null, dosage: null, frequency: null,
      timesOfDay: [], totalQuantity: null, quantityPerDose: null,
    };
  }

  // Ensure all expected keys exist
  parsed.name = parsed.name ?? null;
  parsed.dosage = parsed.dosage ?? null;
  parsed.frequency = parsed.frequency ?? null;
  parsed.timesOfDay = Array.isArray(parsed.timesOfDay) ? parsed.timesOfDay : [];
  parsed.totalQuantity = typeof parsed.totalQuantity === "number" ? parsed.totalQuantity : null;
  parsed.quantityPerDose = typeof parsed.quantityPerDose === "number" ? parsed.quantityPerDose : null;

  const rawText = parsed.rawText ?? cleaned;
  return { rawText, parsed };
}

async function callOpenAI(imageDataUrl: string): Promise<{ rawText: string; parsed: any }> {
  console.log(`[scan] calling OpenAI: gpt-4o`);

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: SCAN_PROMPT },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      }],
      max_tokens: 1200,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content ?? "";
  console.log(`[scan] OpenAI success, length: ${text.length}`);
  return parseOcrResponse(text);
}

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

  // Try OpenAI first, then Groq
  if (OPENAI_API_KEY) {
    try {
      const result = await callOpenAI(imageDataUrl);
      res.json(result);
      return;
    } catch (e: any) {
      console.error(`[scan] OpenAI failed: ${e.message}, trying Groq...`);
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

  res.status(503).json({ error: "No OCR API key configured. Set OPENAI_API_KEY or GROQ_API_KEY." });
});
