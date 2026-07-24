import { Router } from "express";
import { requireAuth } from "../auth.js";
import { getDeviceTelemetry, getAllDeviceTelemetry, publishDeviceCommand } from "../mqttBroker.js";

export const hardwareRouter = Router();

hardwareRouter.use(requireAuth);

/** GET /api/hardware/devices — list all known ESP32 devices with telemetry */
hardwareRouter.get("/devices", (_req, res) => {
  const devices = getAllDeviceTelemetry();
  res.json({ devices });
});

/** GET /api/hardware/devices/:deviceId — telemetry for one device */
hardwareRouter.get("/devices/:deviceId", (req, res) => {
  const tel = getDeviceTelemetry(req.params.deviceId);
  if (!tel) {
    res.status(404).json({ error: "Device not found or offline" });
    return;
  }
  res.json(tel);
});

/** POST /api/hardware/devices/:deviceId/dispense — send dispense command */
hardwareRouter.post("/devices/:deviceId/dispense", (req, res) => {
  try {
    publishDeviceCommand(req.params.deviceId, { action: "dispense", ...req.body });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e.message || "Failed to send command" });
  }
});

/** POST /api/hardware/devices/:deviceId/buzzer — send buzzer command */
hardwareRouter.post("/devices/:deviceId/buzzer", (req, res) => {
  try {
    publishDeviceCommand(req.params.deviceId, {
      action: "buzzer",
      pattern: req.body.pattern ?? "beep",
      duration: req.body.duration ?? 1000,
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e.message || "Failed to send command" });
  }
});
