const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "YOUR_NVIDIA_API_KEY";
const url = "https://integrate.api.nvidia.com/v1/chat/completions";

// 1x1 red PNG
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

console.log("Posting vision OCR model (up to 120s)...");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 120000);
const body = {
  model: "meta/llama-3.2-90b-vision-instruct",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What color is this image? Reply in one word." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    },
  ],
  max_tokens: 30,
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
  console.log("Body:", text.slice(0, 600));
} catch (e) {
  console.log("Error:", e.name === "AbortError" ? "TIMEOUT/ABORTED" : e.message);
} finally {
  clearTimeout(timer);
}
