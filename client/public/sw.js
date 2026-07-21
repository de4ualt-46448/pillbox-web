// Service Worker for push notifications
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Pillbox", body: event.data.text() };
  }

  const options = {
    body: data.body,
    icon: "/pill-icon-192.png",
    badge: "/pill-icon-192.png",
    vibrate: [200, 100, 200],
    tag: data.medicationId || "pillbox-reminder",
    renotify: true,
    data: { medicationId: data.medicationId, url: "/" },
    actions: [
      { action: "taken", title: "Taken ✓" },
      { action: "snooze", title: "Snooze 15min" },
    ],
  };

  event.waitUntil(self.registration.showNotification(data.title || "Pillbox Reminder", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const action = event.action;
  const data = event.notification.data;

  if (action === "snooze") {
    // Re-show notification after 15 minutes
    setTimeout(() => {
      self.registration.showNotification("Pillbox Reminder (snoozed)", {
        body: "Time to take your medication!",
        tag: "snoozed",
        renotify: true,
      });
    }, 15 * 60 * 1000);
    return;
  }

  // Open/focus the app
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/") && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(data?.url || "/");
      }
    }),
  );
});
