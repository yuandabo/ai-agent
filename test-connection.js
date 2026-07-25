import { ProxyAgent, setGlobalDispatcher } from "undici";

const apiKey = process.env.OPENAI_API_KEY?.trim();
const baseURL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/$/, "");
const model = process.env.OPENAI_MODEL || "gpt-5.5";
const proxyUrl =
  process.env.HTTPS_PROXY?.trim() ||
  process.env.HTTP_PROXY?.trim() ||
  process.env.ALL_PROXY?.trim();

if (!apiKey) {
  console.error("ERROR: OPENAI_API_KEY is missing. Check your .env file.");
  process.exit(1);
}

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

console.log("OPENAI_API_KEY loaded");
console.log(`Key prefix: ${apiKey.slice(0, 12)}...`);
console.log(`Base URL: ${baseURL}`);
console.log(`Model: ${model}`);
console.log(`Proxy: ${proxyUrl ? "enabled" : "not configured"}`);
console.log("Testing chat completions connection...");

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 20_000);

try {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with one short sentence." }],
    }),
    signal: controller.signal,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("Request failed");
    console.error("Status:", response.status);
    console.error("Body:", typeof data === "string" ? data : JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log("Connection OK");
  console.log("Reply:", data.choices?.[0]?.message?.content);
} catch (error) {
  console.error("Request failed");
  console.error("Type:", error.constructor?.name);
  console.error("Message:", error.message);
  process.exit(1);
} finally {
  clearTimeout(timeout);
}
