import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const apiKey = process.env.OPENAI_API_KEY?.trim();
const baseURL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
const model = process.env.OPENAI_MODEL || "gpt-5.5";
const proxyUrl = process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim() || process.env.ALL_PROXY?.trim();
const dataDir = resolve(process.env.AGENT_DATA_DIR || "data");
const workspace = resolve(process.env.AGENT_WORKSPACE || "workspace");
const contextBudget = Number(process.env.AGENT_CONTEXT_CHARS || 24_000);
const ragBudget = Number(process.env.AGENT_RAG_CHARS || 5_000);
const ragLimit = Number(process.env.AGENT_RAG_LIMIT || 5);
const maxFileBytes = 1024 * 1024;
const maxImageBytes = Number(process.env.AGENT_MAX_IMAGE_BYTES || 4 * 1024 * 1024);

if (!apiKey) throw new Error("OPENAI_API_KEY is missing. Check your .env file.");
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
mkdirSync(dataDir, { recursive: true });
await mkdir(workspace, { recursive: true });

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
  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments TEXT NOT NULL,
    result TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS message_search (
  message_id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_search_conversation ON message_search(conversation_id, message_id)`);
const ragEnabled = true;

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取工作目录内的 UTF-8 文本文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作目录内的相对路径" } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "在工作目录内写入 UTF-8 文本文件，会覆盖已有文件并自动创建父目录",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "工作目录内的相对路径" },
          content: { type: "string", description: "完整文件内容" }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "列出工作目录内指定目录的文件和子目录",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "相对目录路径，根目录使用 ." } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "file_info",
      description: "获取工作目录内文件或目录的类型、大小和修改时间",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作目录内的相对路径" } },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "在工作目录的 UTF-8 文本文件中递归搜索字符串，最多返回 50 条结果",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "搜索起始目录或文件的相对路径" },
          query: { type: "string", description: "要搜索的文本，区分大小写" }
        },
        required: ["path", "query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "在工作目录内创建目录，包括缺失的父目录",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "工作目录内的相对目录路径" } },
        required: ["path"],
        additionalProperties: false
      }
    }
  }
];

function now() {
  return new Date().toISOString();
}

function normalizeUserContent(input, attachments = []) {
  const text = typeof input === "string" ? input.trim() : "";
  const validAttachments = Array.isArray(attachments) ? attachments : [];
  const images = validAttachments.filter((item) =>
        item &&
        typeof item.dataUrl === "string" &&
        item.dataUrl.startsWith("data:image/") &&
        Buffer.byteLength(item.dataUrl, "utf8") <= maxImageBytes * 1.4
      );
  const textFiles = validAttachments.filter((item) =>
    item &&
    item.kind === "text" &&
    typeof item.name === "string" &&
    typeof item.content === "string" &&
    Buffer.byteLength(item.content, "utf8") <= maxFileBytes
  );

  if (!images.length && !textFiles.length) return text;
  return [
    { type: "text", text: text || (images.length ? "请分析附件。" : "请阅读附件。") },
    ...textFiles.map((item) => ({
      type: "text_file",
      name: item.name.replace(/[\r\n]/g, " "),
      content: item.content
    })),
    ...images.map((item) => ({
      type: "image_url",
      image_url: { url: item.dataUrl }
    }))
  ];
}

function serializeContent(content) {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function deserializeContent(content) {
  if (typeof content !== "string") return content;
  if (!content.trim().startsWith("[")) return content;
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : content;
  } catch {
    return content;
  }
}

function contentToText(content) {
  const value = deserializeContent(content);
  if (typeof value === "string") return value;
  return value.map((part) => {
    if (part.type === "text") return part.text || "";
    if (part.type === "text_file") return `[文本附件：${part.name}]\n${part.content || ""}`;
    if (part.type === "image_url") return "[图片]";
    return `[${part.type || "附件"}]`;
  }).filter(Boolean).join("\n");
}

function contentForModel(content) {
  const value = deserializeContent(content);
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (part.type !== "text_file") return part;
    return {
      type: "text",
      text: `--- 文本附件：${part.name || "未命名文件"} ---\n${part.content || ""}\n--- 附件结束 ---`
    };
  });
}

function ragQuery(text) {
  const compact = text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  const terms = [];
  const width = compact.length < 6 ? 2 : 3;
  for (let index = 0; index <= compact.length - width && terms.length < 24; index += 1) {
    const term = compact.slice(index, index + width);
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

function indexMessage(messageId, conversationId, role, content) {
  if (!ragEnabled) return;
  const text = contentToText(content).slice(0, 50_000);
  if (text.length < 3) return;
  db.prepare("INSERT OR REPLACE INTO message_search (conversation_id, message_id, role, content) VALUES (?, ?, ?, ?)")
    .run(conversationId, messageId, role, text);
}

function backfillMessageSearch() {
  if (!ragEnabled) return;
  const indexed = db.prepare("SELECT COUNT(*) AS count FROM message_search").get().count;
  if (indexed) return;
  const rows = db.prepare("SELECT id, conversation_id, role, content FROM messages ORDER BY id").all();
  for (const row of rows) indexMessage(row.id, row.conversation_id, row.role, row.content);
}

function retrieveMemories(conversationId, query, excludedIds) {
  if (!ragEnabled || ragLimit <= 0 || ragBudget <= 0) return [];
  const terms = ragQuery(query);
  if (!terms.length) return [];
  const rows = db.prepare(`SELECT message_id, role, content FROM message_search
    WHERE conversation_id = ? ORDER BY message_id DESC LIMIT 2000`).all(conversationId)
    .map((row) => {
      const lower = row.content.toLowerCase();
      const hits = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
      return { ...row, score: hits / terms.length };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || right.message_id - left.message_id);
  const memories = [];
  let used = 0;
  for (const row of rows) {
    if (excludedIds.has(Number(row.message_id))) continue;
    const text = row.content.slice(0, 2_000);
    if (used + text.length > ragBudget) continue;
    memories.push({ id: Number(row.message_id), role: row.role, content: text });
    used += text.length;
    if (memories.length >= ragLimit) break;
  }
  return memories.sort((left, right) => left.id - right.id);
}

backfillMessageSearch();

function resolveWorkspacePath(input) {
  if (typeof input !== "string" || !input.trim() || isAbsolute(input)) throw new Error("path 必须是相对路径");
  const target = resolve(workspace, input);
  const local = relative(workspace, target);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error("禁止访问工作目录之外的文件");
  if (local.split(/[\\/]+/).some((part) => [".env", ".git", "node_modules"].includes(part))) {
    throw new Error("禁止访问敏感文件或目录");
  }
  return target;
}

async function searchText(startPath, query) {
  if (typeof query !== "string" || !query.length || query.length > 500) throw new Error("query 长度必须为 1 到 500 个字符");
  const matches = [];
  const pending = [{ absolute: resolveWorkspacePath(startPath), relative: startPath }];
  let scannedFiles = 0;

  while (pending.length && matches.length < 50 && scannedFiles < 500) {
    const current = pending.pop();
    const info = await stat(current.absolute);
    if (info.isDirectory()) {
      const entries = await readdir(current.absolute, { withFileTypes: true });
      for (const entry of entries.reverse()) {
        if (entry.isSymbolicLink() || [".git", "node_modules", ".env"].includes(entry.name)) continue;
        const childRelative = relative(workspace, resolve(current.absolute, entry.name));
        pending.push({ absolute: resolveWorkspacePath(childRelative), relative: childRelative });
      }
      continue;
    }
    if (!info.isFile() || info.size > maxFileBytes) continue;
    scannedFiles += 1;
    let content;
    try { content = await readFile(current.absolute, "utf8"); } catch { continue; }
    if (content.includes("\u0000")) continue;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.includes(query)) continue;
      matches.push({ path: current.relative, line: index + 1, text: line.slice(0, 300) });
      if (matches.length >= 50) break;
    }
  }
  return { ok: true, query, matches, truncated: matches.length >= 50 || pending.length > 0, scannedFiles };
}

async function executeTool(name, rawArguments) {
  let args;
  try {
    args = JSON.parse(rawArguments || "{}");
    if (name === "read_file") {
      const content = await readFile(resolveWorkspacePath(args.path), "utf8");
      if (Buffer.byteLength(content) > maxFileBytes) throw new Error("文件超过 1 MB");
      return { ok: true, path: args.path, content };
    }
    if (name === "write_file") {
      if (typeof args.content !== "string") throw new Error("content 必须是字符串");
      const bytes = Buffer.byteLength(args.content);
      if (bytes > maxFileBytes) throw new Error("写入内容超过 1 MB");
      const target = resolveWorkspacePath(args.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, args.content, "utf8");
      return { ok: true, path: args.path, bytes };
    }
    if (name === "list_directory") {
      const entries = await readdir(resolveWorkspacePath(args.path), { withFileTypes: true });
      return {
        ok: true,
        path: args.path,
        entries: entries.slice(0, 200).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
        })),
        truncated: entries.length > 200
      };
    }
    if (name === "file_info") {
      const info = await stat(resolveWorkspacePath(args.path));
      return { ok: true, path: args.path, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, modifiedAt: info.mtime.toISOString() };
    }
    if (name === "search_text") return await searchText(args.path, args.query);
    if (name === "create_directory") {
      await mkdir(resolveWorkspacePath(args.path), { recursive: true });
      return { ok: true, path: args.path };
    }
    throw new Error(`未知工具：${name}`);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function chat(messages, includeTools = true) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, ...(includeTools ? { tools, tool_choice: "auto" } : {}) })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }
  if (!response.ok) throw new Error(data.error?.message || `API request failed (${response.status})`);
  return data.choices?.[0]?.message;
}

function apiErrorMessage(response, text) {
  let message = "";
  try {
    const data = JSON.parse(text);
    message = data.error?.message || data.message || "";
  } catch {
    if (!text.trim().startsWith("<")) message = text.trim();
  }
  if (message.length > 300) message = `${message.slice(0, 300)}...`;
  return message || `上游 API 请求失败（HTTP ${response.status}）`;
}

async function streamChat(messages, onText, options = {}) {
  const responseFormat = options.structuredOutput ? {
    type: "json_schema",
    json_schema: {
      name: options.structuredOutput.name,
      strict: true,
      schema: options.structuredOutput.schema
    }
  } : undefined;
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", stream: true, ...(responseFormat ? { response_format: responseFormat } : {}) })
  });
  if (!response.ok) throw new Error(apiErrorMessage(response, await response.text()));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = [];
  let content = "";
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const raw = line.trim();
      if (!raw.startsWith("data:")) continue;
      const payload = raw.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let delta;
      try { delta = JSON.parse(payload).choices?.[0]?.delta; } catch { continue; }
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const part of delta.tool_calls || []) {
        const index = part.index ?? 0;
        toolCalls[index] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (part.id) toolCalls[index].id = part.id;
        if (part.function?.name) toolCalls[index].function.name += part.function.name;
        if (part.function?.arguments) toolCalls[index].function.arguments += part.function.arguments;
      }
    }
  }
  return { role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : undefined };
}

function getConversation(id) {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
}

function listConversations() {
  return db.prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50").all();
}

function deleteConversation(id) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM message_search WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM tool_calls WHERE conversation_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    const deleted = db.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
    db.exec("COMMIT");
    return deleted;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getMessages(conversationId) {
  return db.prepare("SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id").all(conversationId);
}

function createConversation(firstMessage) {
  const id = randomUUID();
  const timestamp = now();
  const title = contentToText(firstMessage).replace(/\s+/g, " ").trim() || "图片对话";
  db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, title.slice(0, 40), timestamp, timestamp);
  return id;
}

function saveMessage(conversationId, role, content) {
  const saved = db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, role, serializeContent(content), now());
  indexMessage(Number(saved.lastInsertRowid), conversationId, role, content);
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conversationId);
}

function buildContext(conversationId, query = "") {
  const conversation = getConversation(conversationId);
  const rows = db.prepare("SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC").all(conversationId);
  const selected = [];
  const recentBudget = Math.max(4_000, contextBudget - ragBudget - conversation.summary.length);
  let used = 0;
  for (const row of rows) {
    const size = contentToText(row.content).length + 32;
    if (selected.length && used + size > recentBudget) break;
    selected.push(row);
    used += size;
  }
  const messages = [{
    role: "system",
    content: "你是一个中文 AI Agent。回答清晰、具体。仅在用户要求读写文件时使用工具，完成后说明相对路径。"
  }];
  if (conversation.summary) messages.push({ role: "system", content: `较早对话摘要：\n${conversation.summary}` });
  const memories = retrieveMemories(conversationId, query, new Set(selected.map((row) => row.id)));
  if (memories.length) {
    const recalled = memories.map((row) => `[消息 ${row.id} / ${row.role}]\n${row.content}`).join("\n\n");
    messages.push({ role: "system", content: `以下是从较早对话中检索出的相关记忆，仅作为背景参考：\n${recalled}` });
  }
  messages.push(...selected.reverse().map(({ role, content }) => ({ role, content: contentForModel(content) })));
  return messages;
}

async function refreshSummary(conversationId) {
  const conversation = getConversation(conversationId);
  const rows = db.prepare(
    "SELECT id, role, content FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id"
  ).all(conversationId, conversation.summarized_until);
  if (rows.length < 20) return;
  const toSummarize = rows.slice(0, -8);
  if (!toSummarize.length) return;
  const transcript = toSummarize.map((row) => `${row.role}: ${contentToText(row.content)}`).join("\n");
  const result = await chat([
    { role: "system", content: "把对话压缩为简洁、准确的长期摘要，保留用户目标、事实、决定、约束、文件路径和未完成事项。只输出摘要。" },
    { role: "user", content: `已有摘要：\n${conversation.summary || "无"}\n\n新增对话：\n${transcript}` }
  ], false);
  db.prepare("UPDATE conversations SET summary = ?, summarized_until = ? WHERE id = ?")
    .run(result.content || conversation.summary, toSummarize.at(-1).id, conversationId);
}

async function runTurn(conversationId, input, attachments = []) {
  const userContent = normalizeUserContent(input, attachments);
  saveMessage(conversationId, "user", userContent);
  const messages = buildContext(conversationId, contentToText(userContent));

  for (let round = 0; round < 8; round += 1) {
    const assistant = await chat(messages);
    const calls = assistant.tool_calls || [];
    if (!calls.length) {
      const content = assistant.content || "";
      saveMessage(conversationId, "assistant", content);
      await refreshSummary(conversationId);
      return content;
    }

    messages.push(assistant);
    for (const call of calls) {
      const result = await executeTool(call.function.name, call.function.arguments);
      const resultText = JSON.stringify(result);
      db.prepare(`INSERT INTO tool_calls
        (conversation_id, call_id, tool_name, arguments, result, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(conversationId, call.id, call.function.name, call.function.arguments, resultText, result.ok ? "success" : "error", now());
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }
  throw new Error("工具调用超过 8 轮，已停止执行");
}

async function runTurnStream(conversationId, input, onEvent, attachments = [], options = {}) {
  const userContent = normalizeUserContent(input, attachments);
  saveMessage(conversationId, "user", userContent);
  const messages = buildContext(conversationId, contentToText(userContent));
  for (let round = 0; round < 8; round += 1) {
    const assistant = await streamChat(messages, (text) => onEvent({ type: "delta", text }), options);
    const calls = assistant.tool_calls || [];
    if (!calls.length) {
      const content = assistant.content || "";
      if (options.structuredOutput) {
        try { JSON.parse(content); } catch { throw new Error("模型未返回合法 JSON；中转站可能不支持 JSON Schema 结构化输出"); }
      }
      saveMessage(conversationId, "assistant", content);
      await refreshSummary(conversationId);
      return content;
    }
    messages.push(assistant);
    for (const call of calls) {
      onEvent({ type: "tool", name: call.function.name });
      const result = await executeTool(call.function.name, call.function.arguments);
      const resultText = JSON.stringify(result);
      db.prepare(`INSERT INTO tool_calls
        (conversation_id, call_id, tool_name, arguments, result, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(conversationId, call.id, call.function.name, call.function.arguments, resultText, result.ok ? "success" : "error", now());
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }
  throw new Error("工具调用超过 8 轮，已停止执行");
}

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

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  let conversationId = options.conversationId;
  if (conversationId && !getConversation(conversationId)) throw new Error(`会话不存在：${conversationId}`);

  async function respond(input) {
    if (!conversationId) conversationId = createConversation(input);
    const answer = await runTurn(conversationId, input);
    console.log(`\nAssistant:\n${answer}\n`);
  }

  if (options.prompt) {
    await respond(options.prompt);
    console.log(`Conversation: ${conversationId}`);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Model: ${model}`);
    console.log(conversationId ? `继续会话：${conversationId}` : "新会话（输入 /exit 退出）");
    try {
      while (true) {
        const input = (await rl.question("\nYou: ")).trim();
        if (!input) continue;
        if (["/exit", "/quit"].includes(input)) break;
        await respond(input);
        console.log(`Conversation: ${conversationId}`);
      }
    } finally {
      rl.close();
    }
  }
  db.close();
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await runCli();

export { createConversation, deleteConversation, getConversation, getMessages, listConversations, model, runTurn, runTurnStream };
