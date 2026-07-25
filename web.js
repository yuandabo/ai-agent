import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConversation, deleteConversation, getConversation, getMessages, listConversations, model, runTurnStream } from "./serve.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.WEB_PORT || 3001);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function isValidAttachment(item) {
  const image = item &&
    typeof item.name === "string" &&
    typeof item.type === "string" &&
    item.type.startsWith("image/") &&
    typeof item.dataUrl === "string" &&
    item.dataUrl.startsWith("data:image/");
  const text = item &&
    typeof item.name === "string" &&
    item.kind === "text" &&
    typeof item.content === "string" &&
    Buffer.byteLength(item.content, "utf8") <= 1024 * 1024;
  return image || text;
}

function normalizeStructuredOutput(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.name)) {
    throw new Error("结构化输出名称无效");
  }
  if (!value.schema || value.schema.type !== "object" || typeof value.schema.properties !== "object" || Array.isArray(value.schema.properties)) {
    throw new Error("JSON Schema 根节点必须是 object 并包含 properties");
  }
  if (Buffer.byteLength(JSON.stringify(value.schema), "utf8") > 64 * 1024) throw new Error("JSON Schema 不能超过 64 KB");
  return { name: value.name, schema: value.schema };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/conversations") {
    json(res, 200, { conversations: listConversations(), model });
    return true;
  }

  const match = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (req.method === "DELETE" && match) {
    const id = decodeURIComponent(match[1]);
    if (!deleteConversation(id)) json(res, 404, { error: "会话不存在" });
    else json(res, 200, { ok: true });
    return true;
  }
  if (req.method === "GET" && match) {
    const id = decodeURIComponent(match[1]);
    const conversation = getConversation(id);
    if (!conversation) json(res, 404, { error: "会话不存在" });
    else json(res, 200, { conversation, messages: getMessages(id) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await readJson(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const attachments = Array.isArray(body.attachments) ? body.attachments.filter(isValidAttachment).slice(0, 4) : [];
      const structuredOutput = normalizeStructuredOutput(body.structuredOutput);

      if (!message && !attachments.length) {
        json(res, 400, { error: "消息不能为空" });
        return true;
      }

      let conversationId = body.conversationId;
      if (conversationId && !getConversation(conversationId)) {
        json(res, 404, { error: "会话不存在" });
        return true;
      }

      if (!conversationId) conversationId = createConversation(message || "图片对话");
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write(`${JSON.stringify({ type: "start", conversationId })}\n`);
      await runTurnStream(conversationId, message, (event) => res.write(`${JSON.stringify(event)}\n`), attachments, { structuredOutput });
      res.end(`${JSON.stringify({ type: "done", conversationId })}\n`);
    } catch (error) {
      if (res.headersSent) res.end(`${JSON.stringify({ type: "error", error: error.message || "请求失败" })}\n`);
      else json(res, 500, { error: error.message || "请求失败" });
    }
    return true;
  }

  return false;
}

async function staticFile(res, pathname) {
  const requested = resolve(publicDir, pathname === "/" ? "index.html" : `.${normalize(pathname)}`);
  if (!requested.startsWith(publicDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const content = await readFile(requested);
    res.writeHead(200, { "content-type": mimeTypes[extname(requested)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    if (!(await api(req, res, url))) json(res, 404, { error: "接口不存在" });
    return;
  }
  if (req.method !== "GET") return res.writeHead(405).end("Method not allowed");
  await staticFile(res, url.pathname);
}).listen(port, () => console.log(`Agent Web: http://localhost:${port}`));
