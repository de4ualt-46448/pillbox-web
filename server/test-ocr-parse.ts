import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/pillbox_test";
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";
process.env.NODE_ENV ??= "test";

const { normalizeDigits, parseOcrResponse } = await import("./src/routes/scan.ts");

assert.equal(normalizeDigits("جرعة ١٢.٥ مل"), "جرعة 12.5 مل");

const parsed = parseOcrResponse(JSON.stringify({
  name: "Panadol Extra",
  dosage: "500 mg",
  frequency: "مرتين يوميا",
  timesOfDay: ["٠٨:٠٠", "20:00", "invalid"],
  totalQuantity: "٣٠",
  quantityPerDose: 1,
  rawText: "بانادول إكسترا 500 mg\nمرتين يوميا",
  confidence: { name: 0.95, dosage: 0.88, frequency: 0.62, totalQuantity: 0.9, quantityPerDose: 0.9 },
  warnings: ["Arabic schedule should be verified"],
}), "groq");

assert.equal(parsed.parsed.name, "Panadol Extra");
assert.equal(parsed.parsed.totalQuantity, 30);
assert.deepEqual(parsed.parsed.timesOfDay, ["08:00", "20:00"]);
assert.equal(parsed.status, "needs_review");
assert.ok(parsed.warnings.some((warning) => warning.includes("Arabic schedule")));
assert.ok(parsed.warnings.some((warning) => warning.includes("uncertain")));

const malformed = parseOcrResponse("not valid json", "nvidia");
assert.equal(malformed.status, "needs_review");
assert.ok(malformed.warnings.length > 0);
assert.equal(malformed.parsed.name, null);

console.log("OCR parser tests passed");
