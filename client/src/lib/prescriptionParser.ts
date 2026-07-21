import type { ParsedMedication } from "../types";

/**
 * Regex extraction over raw OCR text from a pill bottle label or prescription.
 * Improved with broader patterns for better extraction from noisy OCR output.
 */
const dosageRegex = /(\d+(?:\.\d+)?)\s?(mg|mcg|ml|mL|g|IU|mcg|µg)/i;
const quantityRegex = /(?:qty|quantity|count|pack|bottle)[:\s]*?(\d{1,4})/i;
const pillsPerDoseRegex = /(?:take|dose|use|inject)\s+(\d+)\s+(?:pill|tablet|capsule|cap|pills|tablets|capsules)/i;
const timeRegex = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const onceDaily = /once\s+(?:daily|a\s+day)|1x\s*daily|every\s+(?:morning|afternoon|evening|night)/i;
const twiceDaily = /twice\s+(?:daily|a\s+day)|2x\s*daily|every\s+(\d+)\s*h(?:ours?)?/i;
const thriceDaily = /three\s+times?\s+(?:daily|a\s+day)|3x\s*daily/i;
const everyNHours = /every\s+(\d+)\s*h(?:ours?)?/i;
const asNeeded = /as\s+needed|prn|when\s+needed/i;

// Common medication name patterns
const nameExclude = /^(?:take|dose|use|sig|directions?|instructions?|refill|rx|prescription|pharmacy|dispensed|quantity|qty|tablet|capsule|mg|ml|daily|twice|once|three|every|refill|print|date|doctor|patient|note)/i;

export function parsePrescription(rawText: string): ParsedMedication {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Find medication name: first short line with letters that isn't a common label word
  let name: string | null = null;
  for (const line of lines) {
    const len = line.length;
    if (len >= 3 && len <= 50 && /[a-zA-Z]/.test(line) && !dosageRegex.test(line) && !nameExclude.test(line)) {
      name = line.replace(/[^\w\s\-]/g, "").trim();
      if (name.length >= 3) break;
    }
  }

  // Dosage: look for patterns like "500mg", "10 mcg", "5 ml"
  const dosageMatch = rawText.match(dosageRegex);
  const dosage = dosageMatch ? `${dosageMatch[1]}${dosageMatch[2]}` : null;

  // Frequency
  let frequency: string | null = null;
  if (onceDaily.test(rawText)) frequency = "Once daily";
  else if (thriceDaily.test(rawText)) frequency = "Three times daily";
  else if (twiceDaily.test(rawText)) {
    const n = rawText.match(everyNHours);
    frequency = n ? `Every ${n[1]} hours` : "Twice daily";
  } else if (asNeeded.test(rawText)) {
    frequency = "As needed";
  } else {
    const n = rawText.match(everyNHours);
    if (n) frequency = `Every ${n[1]} hours`;
  }

  // Times: extract HH:mm patterns
  const times = Array.from(rawText.matchAll(timeRegex))
    .map((m) => `${m[1].padStart(2, "0")}:${m[2]}`)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Quantity
  const qtyMatch = rawText.match(quantityRegex);
  const totalQuantity = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

  // Pills per dose
  const ppdMatch = rawText.match(pillsPerDoseRegex);
  const quantityPerDose = ppdMatch ? parseInt(ppdMatch[1], 10) : null;

  return { name, dosage, frequency, timesOfDay: times, totalQuantity, quantityPerDose };
}
