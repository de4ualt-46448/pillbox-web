import { ELEVENLABS_API_KEY, ELEVENLABS_BASE_URL } from "../config.js";

interface CloneResult {
  voiceId: string;
}

/**
 * Uploads a voice sample to ElevenLabs and returns the provider-assigned
 * voice id. The API key stays server-side — the browser never sees it.
 */
export async function cloneVoice(
  name: string,
  sampleBuffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<CloneResult> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not configured on the server");
  }

  const form = new FormData();
  form.append("name", name);
  form.append("files", new Blob([sampleBuffer], { type: mimeType || "audio/mpeg" }), filename);

  const res = await fetch(`${ELEVENLABS_BASE_URL}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Voice cloning failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { voice_id?: string };
  if (!json.voice_id) throw new Error("Cloning provider returned no voice id");
  return { voiceId: json.voice_id };
}

/** Synthesizes text in a cloned voice and returns raw audio bytes. */
export async function synthesize(voiceId: string, text: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is not configured on the server");
  }
  const res = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Synthesis failed (${res.status}): ${detail}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
