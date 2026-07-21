async function postTest(label, url, timeoutMs) {
  console.log(`\n--- ${label}: POST ${url} ---`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: 1 }),
    });
    const text = await res.text();
    console.log("HTTP", res.status, ":", text.slice(0, 200));
  } catch (e) {
    console.log("Error:", e.name === "AbortError" ? "TIMEOUT" : e.message);
  } finally {
    clearTimeout(timer);
  }
}

await postTest("NVIDIA root", "https://ai.api.nvidia.com/", 15000);
await postTest("Cloudflare echo", "https://cloudflare.com/cdn-cgi/trace", 15000);
await postTest("example.com", "https://example.com/", 15000);
