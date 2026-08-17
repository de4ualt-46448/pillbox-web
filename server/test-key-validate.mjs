const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
if (!NVIDIA_API_KEY) {
  console.error("Set NVIDIA_API_KEY before running this validation utility.");
  process.exit(1);
}

const candidates = [
  "https://integrate.api.nvidia.com/v1/chat/completions",
  "https://ai.api.nvidia.com/v1/gr/meta/llama-3.1-8b-instruct/chat/completions",
];

const models = ["meta/llama-3.1-8b-instruct", "nvidia/llama-3.1-nemotron-70b-instruct"];

for (const url of candidates) {
  for (const model of models) {
    console.log(`\n=== ${url}  model=${model} ===`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: PONG" }],
          max_tokens: 10,
          temperature: 0,
          stream: false,
        }),
      });
      const text = await res.text();
      console.log("HTTP", res.status);
      console.log(text.slice(0, 400));
      if (res.status !== 404 && res.status !== 400) {
        // non-URL/model error means key reached auth; treat as validated enough
      }
    } catch (e) {
      console.log("Error:", e.name === "AbortError" ? "TIMEOUT" : e.message);
    } finally {
      clearTimeout(timer);
    }
  }
}
