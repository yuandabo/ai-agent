import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const apiKey = process.env.OPENAI_API_KEY?.trim();
const baseURL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
const model = process.env.OPENAI_MODEL || "gpt-5.5";
const proxyUrl = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim() || process.env.ALL_PROXY?.trim();
const dataDir = resolve(process.env.AGENT_DATA_DIR || "data");
const contextBudget = Number(process.env.AGENT_CONTEXT_CHARS || 24_000);

if (!apiKey) throw new Error("OPENAI_API_KEY is missing. Check your .env file.");
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(resolve(dataDir, "agent.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    summarized_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_id ON messages(conversation_id, id);
`);

function parseArguments(args) {
  const values = [...args];
  const index = values.indexOf("--conversation");
  let conversationId;
  if (index !== -1) {
    conversationId = values[index + 1];
    values.splice(index, 2);
  }
  return { conversationId, prompt: values.join(" ").trim() };
}

function now() {
  return new Date().toISOString();
}

function createConversation(prompt) {
  const id = randomUUID();
  const timestamp = now();
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, prompt.slice(0, 40), timestamp, timestamp);
  return id;
}

function saveMessage(conversationId, role, content) {
  db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, role, content, now());
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conversationId);
}

function buildContext(conversationId) {
  const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
  const rows = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC")
    .all(conversationId);
  const selected = [];
  let used = conversation.summary.length;
  for (const row of rows) {
    const size = row.content.length + 32;
    if (selected.length && used + size > contextBudget) break;
    selected.push(row);
    used += size;
  }
  const messages = [{ role: "system", content: "你是一个中文 AI Agent。回答清晰、具体，并延续当前会话上下文。" }];
  if (conversation.summary) messages.push({ role: "system", content: `较早对话摘要：\n${conversation.summary}` });
  messages.push(...selected.reverse());
  return messages;
}

async function complete(messages) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `API request failed (${response.status})`);
  return data.choices?.[0]?.message?.content || "";
}

async function refreshSummary(conversationId) {
  const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
  const rows = db.prepare(
    "SELECT id, role, content FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id"
  ).all(conversationId, conversation.summarized_until);
  if (rows.length < 20) return;
  const olderRows = rows.slice(0, -8);
  if (!olderRows.length) return;
  const transcript = olderRows.map((row) => `${row.role}: ${row.content}`).join("\n");
  const summary = await complete([
    { role: "system", content: "把对话压缩为简洁准确的长期摘要，保留目标、事实、决定、约束和未完成事项。只输出摘要。" },
    { role: "user", content: `已有摘要：\n${conversation.summary || "无"}\n\n新增对话：\n${transcript}` }
  ]);
  db.prepare("UPDATE conversations SET summary = ?, summarized_until = ? WHERE id = ?")
    .run(summary, olderRows.at(-1).id, conversationId);
}

const options = parseArguments(process.argv.slice(2));
const prompt = options.prompt || "我在东莞开了一家煲仔饭，我老家是江西的，帮我取一些煲仔饭的名字给我参考";
let conversationId = options.conversationId;
if (conversationId && !db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)) {
  throw new Error(`会话不存在：${conversationId}`);
}
if (!conversationId) conversationId = createConversation(prompt);
saveMessage(conversationId, "user", prompt);

console.log(`Model: ${model}`);
console.log(`Base URL: ${baseURL}`);
console.log(`Conversation: ${conversationId}`);
console.log(`Prompt: ${prompt}`);
console.log("\nAssistant:\n");

const response = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream: true, messages: buildContext(conversationId) })
});

if (!response.ok) {
  const body = await response.text();
  db.close();
  throw new Error(`Request failed (${response.status}): ${body}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let answer = "";
let finished = false;

while (!finished) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      finished = true;
      break;
    }
    try {
      const content = JSON.parse(data).choices?.[0]?.delta?.content;
      if (content) {
        answer += content;
        process.stdout.write(content);
      }
    } catch {
      // Ignore malformed provider events without losing completed content.
    }
  }
}

process.stdout.write("\n");
saveMessage(conversationId, "assistant", answer);
await refreshSummary(conversationId);
console.log(`\nConversation: ${conversationId}`);
db.close();
