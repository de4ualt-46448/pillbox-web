import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { CLIENT_ORIGIN } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { medicationRouter } from "./routes/medications.js";
import { voiceRouter } from "./routes/voice.js";
import { pushRouter } from "./routes/push.js";
import { scanRouter } from "./routes/scan.js";

export const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
const clientOrigin = CLIENT_ORIGIN?.trim();
app.use(
  cors({
    origin: clientOrigin ? clientOrigin : process.env.NODE_ENV !== "production" ? true : false,
    credentials: true,
  }),
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  }),
);
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later" },
});
app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.get("/api/health", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/medications", medicationRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/push", pushRouter);
app.use("/api/scan", scanRouter);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});
