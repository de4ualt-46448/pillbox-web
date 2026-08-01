import { API_BASE } from "./api";

/**
 * Local text-to-speech using the browser's Web Speech API (SpeechSynthesis).
 * Mirrors the LOCAL_TTS branch of the Android TextToSpeechManager. Cloned
 * voices are played back as audio fetched from the server instead.
 */
export function speakLocal(text: string, localeTag?: string | null): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve();
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    if (localeTag) utter.lang = localeTag;
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

export function speakCloned(text: string, voiceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(
      `${API_BASE}/api/voice/synthesize/${encodeURIComponent(voiceId)}?text=${encodeURIComponent(text)}`,
    );
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Playback failed"));
    audio.play().catch(reject);
  });
}

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Plays a recorded voice clip (used as the reminder/alarm sound). */
export function playRecording(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Playback failed"));
    audio.play().catch(reject);
  });
}
