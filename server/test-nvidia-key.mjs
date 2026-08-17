const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
if (!NVIDIA_API_KEY) {
  console.error("Set NVIDIA_API_KEY before running this vision smoke test.");
  process.exit(1);
}
const url = "https://ai.api.nvidia.com/v1/gr/meta/llama-3.2-90b-vision-instruct/chat/completions";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

console.log(`Posting to ${url} with 150s timeout...`);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 150000);
const body = {
  model: "meta/llama-3.2-90b-vision-instruct",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Reply with the single word: PONG" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    },
  ],
  max_tokens: 20,
  temperature: 0,
  stream: false,
};
try {
  const res = await fetch(url, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("HTTP status:", res.status);
  console.log("Body:", text.slice(0, 500));
} catch (e) {
  console.log("Error:", e.name === "AbortError" ? "TIMEOUT/ABORTED after 150s" : e.message);
} finally {
  clearTimeout(timer);
}
