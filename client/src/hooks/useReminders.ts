import { useEffect, useRef } from "react";
import type { Medication, VoiceProfile } from "../types";

interface ReminderOptions {
  enabled: boolean;
  medications: Medication[];
  voiceProfiles: VoiceProfile[];
  /** Called when a dose time is reached — play audio / stream to hardware. */
  onFire: (medication: Medication, voice: VoiceProfile | null) => void;
}

const CHECK_INTERVAL_MS = 20000;
const FIRE_WINDOW_MS = 60000;

function requestNotificationPermission(): void {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/**
 * Client-side reminder scheduler, ported from the Android ReminderScheduler +
 * ReminderReceiver. Browsers can't wake a closed tab the way AlarmManager can,
 * so this polls while the app is open and fires a Notification + spoken
 * reminder for each due time-of-day slot (once per slot per day). For
 * background delivery on published apps, add a service worker + Web Push.
 */
export function useReminders({ enabled, medications, voiceProfiles, onFire }: ReminderOptions): void {
  const firedToday = useRef<Set<string>>(new Set());
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;

  useEffect(() => {
    if (!enabled) return;
    requestNotificationPermission();

    const dayKey = () => new Date().toISOString().slice(0, 10);

    const tick = () => {
      const now = new Date();
      const today = dayKey();
      for (const med of medications) {
        for (const time of med.timesOfDay) {
          const [h, m] = time.split(":").map(Number);
          const trigger = new Date(now);
          trigger.setHours(h, m, 0, 0);
          const diff = now.getTime() - trigger.getTime();
          const slotKey = `${today}:${med.id}:${time}`;
          if (diff >= 0 && diff <= FIRE_WINDOW_MS && !firedToday.current.has(slotKey)) {
            firedToday.current.add(slotKey);
            const voice = voiceProfiles.find((v) => v.isDefault) ?? null;
            onFireRef.current(med, voice);
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification("Medication reminder", {
                body: `Time to take your ${med.name} (${med.dosage}).`,
              });
            }
          }
        }
      }
    };

    tick();
    const id = setInterval(tick, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, medications, voiceProfiles]);
}
