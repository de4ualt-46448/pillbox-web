import { Router } from "express";
import webPush from "web-push";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, getAuth } from "../auth.js";

// Generate VAPID keys with: npx web-push generate-vapid-keys
// Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? "";

if (vapidPublicKey && vapidPrivateKey) {
  webPush.setVapidDetails("mailto:admin@pillbox.local", vapidPublicKey, vapidPrivateKey);
}

export const pushRouter = Router();
pushRouter.use(requireAuth);

// GET /api/push/vapid-key -> returns the public key for the client
pushRouter.get("/vapid-key", (_req, res) => {
  if (!vapidPublicKey) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }
  res.json({ key: vapidPublicKey });
});

// POST /api/push/subscribe -> save push subscription
const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

pushRouter.post("/subscribe", async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid subscription" });
    return;
  }
  const auth = getAuth(req);
  const { endpoint, keys } = parsed.data;

  await prisma.pushSubscription.upsert({
    where: {
      userId_endpoint: { userId: auth.userId, endpoint },
    },
    update: { p256dh: keys.p256dh, auth: keys.auth },
    create: { userId: auth.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
  });

  res.json({ ok: true });
});

// POST /api/push/unsubscribe -> remove push subscription
pushRouter.post("/unsubscribe", async (req, res) => {
  const auth = getAuth(req);
  const endpoint = req.body?.endpoint as string | undefined;
  if (!endpoint) {
    res.status(400).json({ error: "endpoint required" });
    return;
  }
  await prisma.pushSubscription.deleteMany({
    where: { userId: auth.userId, endpoint },
  });
  res.json({ ok: true });
});

/** Send a push notification to all of a user's subscriptions. */
export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; medicationId?: string },
): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) return;

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  const jsonPayload = JSON.stringify(payload);

  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        jsonPayload,
      );
    } catch (err: any) {
      // 404/410 = subscription expired, remove it
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      } else {
        console.error("[push] Failed to send:", err.message);
      }
    }
  }
}
