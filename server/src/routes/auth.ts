import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  verifyToken,
  requireAuth,
  getAuth,
} from "../auth.js";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const signinSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
  const payload = { userId: user.id, email: user.email };
  setRefreshCookie(res, signRefreshToken(payload));
  res.status(201).json({ accessToken: signAccessToken(payload), user: { id: user.id, email: user.email } });
});

authRouter.post("/signin", async (req, res) => {
  const parsed = signinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const payload = { userId: user.id, email: user.email };
  setRefreshCookie(res, signRefreshToken(payload));
  res.json({ accessToken: signAccessToken(payload), user: { id: user.id, email: user.email } });
});

authRouter.post("/refresh", (req, res) => {
  const token = req.cookies?.pillbox_refresh as string | undefined;
  if (!token) {
    res.status(401).json({ error: "No refresh token" });
    return;
  }
  try {
    const payload = verifyToken(token);
    res.json({ accessToken: signAccessToken(payload) });
  } catch {
    clearRefreshCookie(res);
    res.status(401).json({ error: "Refresh token expired" });
  }
});

authRouter.post("/signout", (req, res) => {
  clearRefreshCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  const auth = getAuth(req);
  res.json({ user: { id: auth.userId, email: auth.email } });
});
