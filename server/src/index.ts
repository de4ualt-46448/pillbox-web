import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, HOST, WS_PATH, CLIENT_ORIGIN } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { medicationRouter } from "./routes/medications.js";
import { voiceRouter } from "./routes/voice.js";
import { pushRouter } from "./routes/push.js";
import { scanRouter } from "./routes/scan.js";
import { attachHardwareWs } from "./hardwareWs.js";
import { startMqttBroker } from "./mqttBroker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: require CLIENT_ORIGIN in production; allow any origin only in dev
const clientOrigin = CLIENT_ORIGIN?.trim();
app.use(
  cors({
    origin: clientOrigin ? clientOrigin : process.env.NODE_ENV !== "production" ? true : false,
    credentials: true,
  }),
);

// Global rate limiter: 200 req / 15 min per IP
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  }),
);

// Stricter limiter for auth endpoints: 15 attempts / 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts, please try again later" },
});

app.use(express.json({ limit: "20mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));
app.use("/api/auth", authLimiter, authRouter);
app.use("/api/medications", medicationRouter);
app.use("/api/voice", voiceRouter);
app.use("/api/push", pushRouter);
app.use("/api/scan", scanRouter);

// Serve the built client in production (optional).
const clientDist = path.resolve(__dirname, "../../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

// Global error handler — catches unhandled route errors
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[server] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = createServer(app);
attachHardwareWs(server);
startMqttBroker();

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down gracefully…`);
  server.close(() => {
    console.log("[server] HTTP server closed");
    process.exit(0);
  });
  // Force close after 5s
  setTimeout(() => {
    console.error("[server] forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
  console.log(`[server] hardware WS at ws://${HOST}:${PORT}${WS_PATH}`);
});
