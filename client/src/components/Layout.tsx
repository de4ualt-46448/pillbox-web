import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { BottomNav } from "../components/BottomNav";
import { useMedications } from "../lib/queries";
import { useVoiceProfiles } from "../lib/queries";
import { useAuth } from "../store/auth";
import { useTheme } from "../store/theme";
import { useReminders } from "../hooks/useReminders";
import { speakLocal, speakCloned, playRecording } from "../lib/tts";
import { useQueryClient } from "@tanstack/react-query";

export function Layout() {
  const navigate = useNavigate();
  const { user, signout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const qc = useQueryClient();
  const { data: medications = [] } = useMedications();
  const { data: voiceProfiles = [] } = useVoiceProfiles();

  useReminders({
    enabled: true,
    medications,
    voiceProfiles,
    onFire: (med, voice) => {
      const text = `It's time to take your ${med.name}, ${med.dosage}.`;
      if (voice?.engine === "RECORDED" && voice.audioUrl) {
        // Play the user's own recorded voice as the alarm/ringtone.
        playRecording(voice.audioUrl).catch(() => speakLocal(text));
      } else if (voice?.engine === "CLONED_REMOTE" && voice.remoteVoiceId) {
        speakCloned(text, voice.remoteVoiceId).catch(() => speakLocal(text));
      } else {
        speakLocal(text, voice?.localeTag);
      }
    },
  });

  return (
    <div className="min-h-full flex justify-center">
      <div className="w-full max-w-md min-h-screen bg-softSurface flex flex-col">
        {/* Header */}
        <header className="px-5 pt-4 pb-2 flex items-center justify-between">
          <div>
            <div className="text-xs text-textSecondary">Signed in as</div>
            <div className="text-sm font-semibold text-textPrimary truncate max-w-[200px]">
              {user?.email}
            </div>
          </div>
<div className="flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="rounded-full px-2.5 py-1 text-xs font-medium text-textSecondary transition-colors hover:bg-softSurface hover:text-textPrimary"
                title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              <button
                onClick={async () => {
                  await signout();
                  navigate("/signin");
                }}
                className="text-sm text-textSecondary hover:text-textPrimary"
              >
                Sign out
              </button>
            </div>
        </header>

        <main className="flex-1 px-5 pb-28">
          <Outlet />
        </main>

        <BottomNav />
      </div>
    </div>
  );
}
