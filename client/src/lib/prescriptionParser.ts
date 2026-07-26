import type { ParsedMedication } from "../types";

/**
 * Regex extraction over raw OCR text from a pill bottle label or prescription.
 * Improved with broader patterns for better extraction from noisy OCR output.
 *
 * Egyptian rosheta (روشتة) are usually mostly Arabic (doctor's handwriting or a
 * pharmacy-printed label) with the drug's brand name in Latin script, so the
 * patterns below cover both English phrasing and the common Arabic equivalents,
 * and Arabic-Indic digits are normalized to Western digits before matching.
 */
const dosageRegex = /(\d+(?:\.\d+)?)\s?(mg|mcg|ml|mL|g|IU|mcg|µg)/i;
const quantityRegex = /(?:qty|quantity|count|pack|bottle)[:\s]*?(\d{1,4})/i;
const pillsPerDoseRegex = /(?:take|dose|use|inject)\s+(\d+)\s+(?:pill|tablet|capsule|cap|pills|tablets|capsules)/i;
const pillsPerDoseRegexAr = /(\d+)\s*(?:قرص|أقراص|اقراص|كبسولة|كبسولات|حبة|حبوب)/;
const timeRegex = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

const onceDaily = /once\s+(?:daily|a\s+day)|1x\s*daily|every\s+(?:morning|afternoon|evening|night)/i;
const twiceDaily = /twice\s+(?:daily|a\s+day)|2x\s*daily|every\s+(\d+)\s*h(?:ours?)?/i;
const thriceDaily = /three\s+times?\s+(?:daily|a\s+day)|3x\s*daily/i;
const everyNHours = /every\s+(\d+)\s*h(?:ours?)?/i;
const asNeeded = /as\s+needed|prn|when\s+needed/i;

// Arabic equivalents commonly seen on rosheta / pharmacy labels
const onceDailyAr = /مرة\s*(?:واحدة)?\s*(?:يوميا|في\s*اليوم|باليوم)/;
const twiceDailyAr = /مرتين\s*(?:يوميا|في\s*اليوم|باليوم)/;
const thriceDailyAr = /(?:3|تلات|ثلاث)\s*مرات\s*(?:يوميا|في\s*اليوم|باليوم)/;
const everyNHoursAr = /كل\s*(\d+)\s*ساع(?:ة|ات)/;
const asNeededAr = /عند\s*(?:اللزوم|الحاجة|الالم)/;

// Common medication name patterns
const nameExclude = /^(?:take|dose|use|sig|directions?|instructions?|refill|rx|prescription|pharmacy|dispensed|quantity|qty|tablet|capsule|mg|ml|daily|twice|once|three|every|refill|print|date|doctor|patient|note)/i;

/**
 * Converts Arabic-Indic (٠-٩) and Extended Arabic-Indic/Persian (۰-۹) digits
 * to standard Western digits so the regexes above (which are all Western-digit
 * based) can match dosages, quantities, and hour counts written in Arabic.
 */
export function normalizeArabicNumerals(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    // Arabic-Indic ٠-٩ = U+0660-U+0669, Extended (Persian) ۰-۹ = U+06F0-U+06F9
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export function parsePrescription(rawTextInput: string): ParsedMedication {
  const rawText = normalizeArabicNumerals(rawTextInput);
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

  // Frequency (checks English phrasing first, then the Arabic equivalents)
  let frequency: string | null = null;
  const everyNHoursMatch = rawText.match(everyNHours) ?? rawText.match(everyNHoursAr);
  if (onceDaily.test(rawText) || onceDailyAr.test(rawText)) frequency = "Once daily";
  else if (thriceDaily.test(rawText) || thriceDailyAr.test(rawText)) frequency = "Three times daily";
  else if (twiceDaily.test(rawText) || twiceDailyAr.test(rawText)) {
    frequency = everyNHoursMatch ? `Every ${everyNHoursMatch[1]} hours` : "Twice daily";
  } else if (asNeeded.test(rawText) || asNeededAr.test(rawText)) {
    frequency = "As needed";
  } else if (everyNHoursMatch) {
    frequency = `Every ${everyNHoursMatch[1]} hours`;
  }

  // Times: extract HH:mm patterns
  const times = Array.from(rawText.matchAll(timeRegex))
    .map((m) => `${m[1].padStart(2, "0")}:${m[2]}`)
    .filter((v, i, a) => a.indexOf(v) === i);

  // Quantity
  const qtyMatch = rawText.match(quantityRegex);
  const totalQuantity = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

  // Pills per dose
  const ppdMatch = rawText.match(pillsPerDoseRegex) ?? rawText.match(pillsPerDoseRegexAr);
  const quantityPerDose = ppdMatch ? parseInt(ppdMatch[1], 10) : null;

  return { name, dosage, frequency, timesOfDay: times, totalQuantity, quantityPerDose };
}