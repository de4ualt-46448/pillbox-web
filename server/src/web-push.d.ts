declare module "web-push" {
  interface PushSubscription {
    endpoint: string;
    keys?: { p256dh: string; auth: string };
  }

  interface SendNotificationOptions {
    TTL?: number;
    urgency?: string;
    topic?: string;
  }

  interface WebPushError extends Error {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
  }

  export function setVapidDetails(
    email: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload: string | Buffer | null,
    options?: SendNotificationOptions,
  ): Promise<void>;

  export function generateVapidKeys(): {
    publicKey: string;
    privateKey: string;
  };
}
