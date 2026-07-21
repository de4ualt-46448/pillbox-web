import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, getAuth } from "../auth.js";

export const medicationRouter = Router();

// All medication routes require auth.
medicationRouter.use(requireAuth);

const toCsv = (times: string[]) => times.map((t) => t.trim()).filter(Boolean).join(",");

const fromCsv = (raw: string): string[] =>
  raw ? raw.split(",").map((t) => t.trim()).filter(Boolean) : [];

const medToJson = (m: {
  id: string;
  name: string;
  dosage: string;
  frequencyRaw: string;
  timesOfDay: string;
  totalQuantity: number;
  pillsRemaining: number;
  quantityPerDose: number;
  notes: string;
  refillDate: Date | null;
  voiceProfileId: string | null;
  lowStockThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: m.id,
  name: m.name,
  dosage: m.dosage,
  frequencyRaw: m.frequencyRaw,
  timesOfDay: fromCsv(m.timesOfDay),
  totalQuantity: m.totalQuantity,
  pillsRemaining: m.pillsRemaining,
  quantityPerDose: m.quantityPerDose,
  notes: m.notes,
  refillDate: m.refillDate?.toISOString() ?? null,
  voiceProfileId: m.voiceProfileId,
  lowStockThreshold: m.lowStockThreshold,
  isLowStock: m.pillsRemaining <= m.lowStockThreshold,
  progressFraction: m.totalQuantity > 0 ? m.pillsRemaining / m.totalQuantity : 0,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

const createSchema = z.object({
  name: z.string().min(1),
  dosage: z.string().min(1).optional(),
  frequencyRaw: z.string().min(1).optional(),
  timesOfDay: z.array(z.string()).default([]),
  totalQuantity: z.number().int().positive().optional(),
  pillsRemaining: z.number().int().min(0).optional(),
  quantityPerDose: z.number().int().positive().optional(),
  notes: z.string().optional(),
  refillDate: z.string().datetime().optional(),
  voiceProfileId: z.string().nullish(),
  lowStockThreshold: z.number().int().min(0).default(5),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  dosage: z.string().min(1).optional(),
  frequencyRaw: z.string().min(1).optional(),
  timesOfDay: z.array(z.string()).optional(),
  totalQuantity: z.number().int().positive().optional(),
  quantityPerDose: z.number().int().positive().optional(),
  notes: z.string().optional(),
  refillDate: z.string().datetime().nullable().optional(),
  voiceProfileId: z.string().nullish(),
  lowStockThreshold: z.number().int().min(0).optional(),
});

// GET /api/medications
medicationRouter.get("/", async (req, res) => {
  const auth = getAuth(req);
  const meds = await prisma.medication.findMany({
    where: { userId: auth.userId },
    orderBy: { name: "asc" },
  });
  res.json(meds.map(medToJson));
});

// POST /api/medications
medicationRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { name, dosage, frequencyRaw, timesOfDay, totalQuantity, quantityPerDose, notes, refillDate, voiceProfileId, lowStockThreshold } = parsed.data;
  const safeDosage = dosage && dosage.length > 0 ? dosage : "As labeled";
  const safeFrequency = frequencyRaw && frequencyRaw.length > 0 ? frequencyRaw : "As directed";
  const safeQty = totalQuantity && totalQuantity > 0 ? totalQuantity : 30;
  const pillsRemaining = parsed.data.pillsRemaining ?? safeQty;
  const auth = getAuth(req);
  const med = await prisma.medication.create({
    data: {
      userId: auth.userId,
      name,
      dosage: safeDosage,
      frequencyRaw: safeFrequency,
      timesOfDay: toCsv(timesOfDay),
      totalQuantity: safeQty,
      pillsRemaining,
      quantityPerDose: quantityPerDose && quantityPerDose > 0 ? quantityPerDose : 1,
      notes: notes ?? "",
      refillDate: refillDate ? new Date(refillDate) : null,
      voiceProfileId: voiceProfileId ?? null,
      lowStockThreshold,
    },
  });
  res.status(201).json(medToJson(med));
});

// GET /api/medications/:id
medicationRouter.get("/:id", async (req, res) => {
  const auth = getAuth(req);
  const med = await prisma.medication.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!med) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(medToJson(med));
});

// PATCH /api/medications/:id
medicationRouter.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const auth = getAuth(req);
  const existing = await prisma.medication.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const data: Record<string, unknown> = {};
  const { timesOfDay, voiceProfileId, refillDate, ...rest } = parsed.data;
  Object.assign(data, rest);
  if (timesOfDay) data.timesOfDay = toCsv(timesOfDay);
  if (voiceProfileId !== undefined) data.voiceProfileId = voiceProfileId ?? null;
  if (refillDate !== undefined) data.refillDate = refillDate ? new Date(refillDate) : null;
  const med = await prisma.medication.update({ where: { id: req.params.id }, data });
  res.json(medToJson(med));
});

// PATCH /api/medications/:id/stock  -> manual correction
medicationRouter.patch("/:id/stock", async (req, res) => {
  const schema = z.object({ pillsRemaining: z.number().int().min(0) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "pillsRemaining required" });
    return;
  }
  const auth = getAuth(req);
  const existing = await prisma.medication.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const med = await prisma.medication.update({
    where: { id: req.params.id },
    data: { pillsRemaining: parsed.data.pillsRemaining },
  });
  res.json(medToJson(med));
});

// POST /api/medications/:id/dose-taken -> recordDoseTaken
medicationRouter.post("/:id/dose-taken", async (req, res) => {
  const auth = getAuth(req);
  const existing = await prisma.medication.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const quantity = (req.body?.quantity && Number(req.body.quantity) > 0)
    ? Number(req.body.quantity)
    : existing.quantityPerDose;
  const source = (req.body?.source as string) || "manual";

  // Update stock and create dose log in a transaction
  const [med] = await prisma.$transaction([
    prisma.medication.update({
      where: { id: req.params.id },
      data: { pillsRemaining: Math.max(existing.pillsRemaining - quantity, 0) },
    }),
    prisma.doseLog.create({
      data: {
        medicationId: req.params.id,
        quantity,
        source,
      },
    }),
  ]);
  res.json(medToJson(med));
});

// GET /api/medications/:id/dose-history
medicationRouter.get("/:id/dose-history", async (req, res) => {
  const auth = getAuth(req);
  const existing = await prisma.medication.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const logs = await prisma.doseLog.findMany({
    where: { medicationId: req.params.id },
    orderBy: { takenAt: "desc" },
    take: limit,
  });
  res.json(
    logs.map((l) => ({
      id: l.id,
      quantity: l.quantity,
      source: l.source,
      takenAt: l.takenAt.toISOString(),
    })),
  );
});

// DELETE /api/medications/:id
medicationRouter.delete("/:id", async (req, res) => {
  const auth = getAuth(req);
  const existing = await prisma.medication.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await prisma.medication.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
