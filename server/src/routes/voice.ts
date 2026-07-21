import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../prisma.js";
import { requireAuth, getAuth } from "../auth.js";
import { cloneVoice, synthesize } from "../voice/elevenlabs.js";
import { UPLOAD_DIR } from "../config.js";

export const voiceRouter = Router();

voiceRouter.use(requireAuth);

const profileToJson = (p: {
  id: string;
  displayName: string;
  engine: string;
  localeTag: string | null;
  remoteVoiceId: string | null;
  audioPath: string | null;
  isDefault: boolean;
  createdAt: Date;
}) => ({
  id: p.id,
  displayName: p.displayName,
  engine: p.engine,
  localeTag: p.localeTag,
  remoteVoiceId: p.remoteVoiceId,
  audioPath: p.audioPath,
  audioUrl: p.audioPath ? `/api/voice/recording/${p.id}` : null,
  isDefault: p.isDefault,
  createdAt: p.createdAt.toISOString(),
});

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

// GET /api/voice-profiles
voiceRouter.get("/", async (req, res) => {
  const auth = getAuth(req);
  const profiles = await prisma.voiceProfile.findMany({
    where: { userId: auth.userId },
    orderBy: { createdAt: "asc" },
  });
  res.json(profiles.map(profileToJson));
});

// POST /api/voice-profiles  (built-in / local voice)
voiceRouter.post("/", async (req, res) => {
  const schema = z.object({
    displayName: z.string().min(1),
    engine: z.enum(["LOCAL_TTS", "CLONED_REMOTE"]).default("LOCAL_TTS"),
    localeTag: z.string().nullish(),
    remoteVoiceId: z.string().nullish(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const auth = getAuth(req);
  const profile = await prisma.voiceProfile.create({
    data: {
      userId: auth.userId,
      displayName: parsed.data.displayName,
      engine: parsed.data.engine,
      localeTag: parsed.data.localeTag ?? null,
      remoteVoiceId: parsed.data.remoteVoiceId ?? null,
    },
  });
  res.status(201).json(profileToJson(profile));
});

// POST /api/voice/clone  (upload a sample, clone via ElevenLabs)
voiceRouter.post("/clone", upload.single("sample"), async (req, res) => {
  const auth = getAuth(req);
  const name = (req.body.name as string) || "Cloned Voice";
  if (!req.file) {
    res.status(400).json({ error: "No audio sample uploaded" });
    return;
  }
  try {
    const buffer = await fs.readFile(req.file.path);
    const { voiceId } = await cloneVoice(
      name,
      buffer,
      req.file.originalname || "sample.webm",
      req.file.mimetype || "audio/webm",
    );
    const profile = await prisma.voiceProfile.create({
      data: {
        userId: auth.userId,
        displayName: name,
        engine: "CLONED_REMOTE",
        remoteVoiceId: voiceId,
      },
    });
    res.status(201).json(profileToJson(profile));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  } finally {
    await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
});

// POST /api/voice/record  (upload a recorded voice clip -> played back as the alarm)
voiceRouter.post("/record", upload.single("sample"), async (req, res) => {
  const auth = getAuth(req);
  const name = (req.body.name as string) || "My Voice";
  if (!req.file) {
    res.status(400).json({ error: "No voice recording uploaded" });
    return;
  }
  const ext = (req.file.originalname.split(".").pop() || "webm").toLowerCase();
  const safeExt = ["webm", "mp3", "m4a", "wav", "ogg"].includes(ext) ? ext : "webm";
  const fileName = `${randomUUID()}.${safeExt}`;
  try {
    await fs.rename(req.file.path, path.join(UPLOAD_DIR, fileName));
    const profile = await prisma.voiceProfile.create({
      data: {
        userId: auth.userId,
        displayName: name,
        engine: "RECORDED",
        audioPath: fileName,
      },
    });
    res.status(201).json(profileToJson(profile));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// GET /api/voice/recording/:id  (stream the stored recording for playback)
voiceRouter.get("/recording/:id", async (req, res) => {
  const auth = getAuth(req);
  const profile = await prisma.voiceProfile.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!profile || !profile.audioPath) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  const file = path.join(UPLOAD_DIR, profile.audioPath);
  try {
    const buf = await fs.readFile(file);
    const ext = profile.audioPath.split(".").pop()?.toLowerCase() ?? "webm";
    const mime =
      ext === "mp3" ? "audio/mpeg" : ext === "wav" ? "audio/wav" : ext === "m4a" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : "audio/webm";
    res.set("content-type", mime);
    res.send(buf);
  } catch {
    res.status(404).json({ error: "Recording file missing" });
  }
});

// POST /api/voice-profiles/:id/default
voiceRouter.post("/:id/default", async (req, res) => {
  const auth = getAuth(req);
  const profile = await prisma.voiceProfile.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!profile) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await prisma.$transaction([
    prisma.voiceProfile.updateMany({
      where: { userId: auth.userId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.voiceProfile.update({
      where: { id: req.params.id },
      data: { isDefault: true },
    }),
  ]);
  res.json({ ok: true });
});

// GET /api/voice/synthesize/:voiceId?text=...  (returns audio bytes for playback)
voiceRouter.get("/synthesize/:voiceId", async (req, res) => {
  const text = (req.query.text as string) || "This is your medication reminder.";
  try {
    const audio = await synthesize(req.params.voiceId, text);
    res.set("content-type", "audio/mpeg");
    res.send(audio);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// DELETE /api/voice-profiles/:id
voiceRouter.delete("/:id", async (req, res) => {
  const auth = getAuth(req);
  const profile = await prisma.voiceProfile.findFirst({
    where: { id: req.params.id, userId: auth.userId },
  });
  if (!profile) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await prisma.voiceProfile.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// keep randomUUID referenced to avoid unused import in some bundlers
void randomUUID;
void path;
