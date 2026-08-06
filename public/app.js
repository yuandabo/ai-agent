const list = document.querySelector("#conversations");
const messages = document.querySelector("#messages");
const form = document.querySelector("#composer");
const input = document.querySelector("#input");
const send = document.querySelector("#send");
const title = document.querySelector("#title");
const conversationLabel = document.querySelector("#conversation-id");
const attach = document.querySelector("#attach");
const fileInput = document.querySelector("#file-input");
const attachmentsView = document.querySelector("#attachments");
const structuredEnabled = document.querySelector("#structured-enabled");
const schemaToggle = document.querySelector("#schema-toggle");
const schemaModal = document.querySelector("#schema-modal");
const schemaInput = document.querySelector("#schema-input");
const schemaSave = document.querySelector("#schema-save");
const commandMenu = document.querySelector("#command-menu");

let conversationId = localStorage.getItem("conversationId");
let attachments = [];
const maxImageDimension = 1600;
const targetImageBytes = 1.5 * 1024 * 1024;
const maxTextFileBytes = 1024 * 1024;
const textExtensions = new Set(["txt", "md", "markdown", "json", "csv", "js", "mjs", "cjs", "ts", "tsx", "jsx", "html", "css", "xml", "yaml", "yml"]);
const defaultSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    keywords: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "keywords"],
  additionalProperties: false
};
let savedSchema = localStorage.getItem("structuredSchema") || JSON.stringify(defaultSchema, null, 2);
structuredEnabled.checked = localStorage.getItem("structuredEnabled") === "true";
let activeCommandIndex = 0;
let visibleCommands = [];

const commands = [
  { name: "/mcp", description: "查看 MCP Server 连接状态" },
  { name: "/tools", description: "查看 MCP 提供的工具" },
  { name: "/new", description: "新建对话" },
  { name: "/clear", description: "清空当前输入" },
  { name: "/schema", description: "配置结构化输出 Schema" },
  { name: "/help", description: "查看所有斜杠指令" }
];

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function parseContent(content) {
  if (typeof content !== "string" || !content.trim().startsWith("[")) return [{ type: "text", text: content || "" }];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [{ type: "text", text: content }];
  } catch {
    return [{ type: "text", text: content }];
  }
}

function renderContent(content) {
  return parseContent(content).map((part) => {
    if (part.type === "text") return `<div>${escapeHtml(part.text || "")}</div>`;
    if (part.type === "image_url") return `<img class="message-image" src="${part.image_url?.url || ""}" alt="用户上传的图片" />`;
    if (part.type === "text_file") return `<div class="message-file"><span class="file-icon">TXT</span><span>${escapeHtml(part.name || "文本附件")}</span></div>`;
    return `<div class="attachment-chip">${escapeHtml(part.type || "附件")}</div>`;
  }).join("");
}

function emptyState() {
  return '<div class="empty"><span>AI</span><h1>开始测试你的 Agent</h1><p>支持流式回复、本地记忆、工具调用和图片输入。</p></div>';
}

function showMessages(items = []) {
  if (!items.length) {
    messages.innerHTML = emptyState();
    return;
  }
  messages.innerHTML = items.map((item) => `
    <article class="message ${item.role}">
      <div class="avatar">${item.role === "user" ? "你" : "AI"}</div>
      <div class="bubble">${renderContent(item.content)}</div>
    </article>`).join("");
  messages.scrollTop = messages.scrollHeight;
}

function addMessage(role, content, files = []) {
  if (messages.querySelector(".empty")) messages.innerHTML = "";
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `<div class="avatar">${role === "user" ? "你" : "AI"}</div><div class="bubble"></div>`;
  const bubble = article.querySelector(".bubble");
  bubble.innerHTML = renderContent(content);
  for (const file of files) {
    if (file.kind === "text") {
      const card = document.createElement("div");
      card.className = "message-file";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = "TXT";
      const name = document.createElement("span");
      name.textContent = file.name;
      card.append(icon, name);
      bubble.append(card);
      continue;
    }
    const img = document.createElement("img");
    img.className = "message-image";
    img.src = file.dataUrl;
    img.alt = file.name;
    bubble.append(img);
  }
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function addError(message) {
  const notice = document.createElement("div");
  notice.className = "error-notice";
  notice.textContent = `请求失败：${message}`;
  messages.append(notice);
  messages.scrollTop = messages.scrollHeight;
}

function closeCommandMenu() {
  commandMenu.hidden = true;
  commandMenu.innerHTML = "";
  visibleCommands = [];
  activeCommandIndex = 0;
}

function renderCommandMenu() {
  const value = input.value.trimStart();
  if (!value.startsWith("/") || /\s/.test(value)) {
    closeCommandMenu();
    return;
  }
  const query = value.toLowerCase();
  visibleCommands = commands.filter((command) => command.name.startsWith(query));
  if (!visibleCommands.length) {
    closeCommandMenu();
    return;
  }
  activeCommandIndex = Math.min(activeCommandIndex, visibleCommands.length - 1);
  commandMenu.innerHTML = visibleCommands.map((command, index) => `
    <button type="button" class="command-option ${index === activeCommandIndex ? "active" : ""}" data-command="${command.name}" role="option" aria-selected="${index === activeCommandIndex}">
      <code>${command.name}</code><span>${command.description}</span>
    </button>`).join("");
  commandMenu.hidden = false;
  commandMenu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function openSchemaModal() {
  schemaInput.value = savedSchema;
  schemaModal.hidden = false;
  schemaInput.focus();
}

async function fetchMcpStatus() {
  const response = await fetch("/api/mcp/status");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "无法读取 MCP 状态");
  return data;
}

async function executeCommand(name) {
  closeCommandMenu();
  input.value = "";
  if (name === "/new") {
    newChat();
    return;
  }
  if (name === "/clear") {
    input.focus();
    return;
  }
  if (name === "/schema") {
    openSchemaModal();
    return;
  }
  if (name === "/help") {
    addMessage("assistant", commands.map((command) => `${command.name}  ${command.description}`).join("\n"));
    return;
  }
  try {
    const data = await fetchMcpStatus();
    if (name === "/mcp") {
      const lines = data.servers.map((server) => {
        const detail = server.status === "connected" ? `${server.toolCount} 个工具` : (server.error || server.status);
        return `${server.status === "connected" ? "已连接" : "未连接"}  ${server.name} (${server.transport}) - ${detail}`;
      });
      addMessage("assistant", `MCP：${data.connected}/${data.servers.length} 个 Server 已连接，共 ${data.totalTools} 个工具\n\n${lines.join("\n")}`);
    } else if (name === "/tools") {
      const lines = data.servers.flatMap((server) => server.tools.map((tool) => `${server.name} / ${tool}`));
      addMessage("assistant", lines.length ? `可用 MCP 工具（${lines.length}）\n\n${lines.join("\n")}` : "当前没有可用的 MCP 工具");
    }
  } catch (error) {
    addError(error.message || "指令执行失败");
  }
}

function renderAttachments() {
  attachmentsView.hidden = attachments.length === 0;
  attachmentsView.innerHTML = attachments.map((item, index) => `
    <div class="attachment">
      ${item.kind === "text" ? '<span class="file-icon">TXT</span>' : `<img src="${item.dataUrl}" alt="${escapeHtml(item.name)}" />`}
      <span>${escapeHtml(item.name)}</span>
      <button type="button" data-remove="${index}" title="移除">x</button>
    </div>`).join("");
}

function isTextFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return file.type.startsWith("text/") || textExtensions.has(extension);
}

async function readTextFile(file) {
  if (file.size > maxTextFileBytes) throw new Error(`${file.name} 超过 1 MB，无法上传`);
  return { kind: "text", name: file.name, type: file.type || "text/plain", content: await file.text() };
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片压缩失败")), "image/jpeg", quality);
  });
}

async function compressImage(file) {
  if (file.size <= targetImageBytes && file.type !== "image/bmp") return readImage(file);

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxImageDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.86;
  let blob = await canvasToBlob(canvas, quality);
  while (blob.size > targetImageBytes && quality > 0.46) {
    quality -= 0.1;
    blob = await canvasToBlob(canvas, quality);
  }

  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  const compressed = new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  return readImage(compressed);
}

async function loadConversations() {
  const response = await fetch("/api/conversations");
  const data = await response.json();
  document.querySelector("#model").textContent = data.model;
  list.innerHTML = data.conversations.map((item) => `
    <div class="conversation ${item.id === conversationId ? "active" : ""}">
      <button class="conversation-open" data-id="${item.id}">
        <span>${escapeHtml(item.title)}</span><small>${new Date(item.updated_at).toLocaleString()}</small>
      </button>
      <button class="conversation-delete" data-delete="${item.id}" title="删除对话" aria-label="删除对话">×</button>
    </div>`).join("");
}

async function removeConversation(id) {
  if (!confirm("确定删除这个对话吗？删除后无法恢复。")) return;
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    addError(data.error || "删除对话失败");
    return;
  }
  if (id === conversationId) newChat();
  else await loadConversations();
}

async function openConversation(id) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!response.ok) {
    newChat();
    return;
  }
  const data = await response.json();
  conversationId = id;
  localStorage.setItem("conversationId", id);
  title.textContent = data.conversation.title;
  conversationLabel.textContent = id;
  showMessages(data.messages);
  await loadConversations();
}

function newChat() {
  conversationId = null;
  attachments = [];
  renderAttachments();
  localStorage.removeItem("conversationId");
  title.textContent = "新对话";
  conversationLabel.textContent = "本地持久化记忆";
  showMessages();
  loadConversations();
  input.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if ((!message && !attachments.length) || send.disabled) return;

  if (!attachments.length && commands.some((command) => command.name === message)) {
    await executeCommand(message);
    return;
  }

  const outgoingAttachments = attachments;
  let structuredOutput = null;
  if (structuredEnabled.checked) {
    try {
      const schema = JSON.parse(savedSchema);
      if (!schema || schema.type !== "object" || typeof schema.properties !== "object") throw new Error("根节点必须是包含 properties 的 object");
      structuredOutput = { name: "agent_response", schema };
    } catch (error) {
      addError(`JSON Schema 无效：${error.message}`);
      return;
    }
  }
  attachments = [];
  renderAttachments();
  input.value = "";
  addMessage("user", message, outgoingAttachments);
  const pending = addMessage("assistant", "正在思考...");
  send.disabled = true;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, message, attachments: outgoingAttachments, structuredOutput })
    });
    if (!response.ok) throw new Error((await response.json()).error || "请求失败");

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      pending.textContent = data.text || "模型没有返回内容";
      conversationId = data.conversationId;
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let completed = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "start") {
            conversationId = event.conversationId;
            pending.textContent = "";
          } else if (event.type === "delta") {
            answer += event.text;
            pending.textContent = answer;
            messages.scrollTop = messages.scrollHeight;
          } else if (event.type === "tool") {
            pending.textContent = answer || `正在调用 ${event.name}...`;
          } else if (event.type === "error") {
            throw new Error(event.error);
          } else if (event.type === "done") {
            completed = true;
          }
        }
      }
      if (!completed && !answer) throw new Error("连接提前中断，请检查中转站状态");
      if (!answer) pending.textContent = "模型没有返回内容";
    }

    localStorage.setItem("conversationId", conversationId);
    conversationLabel.textContent = conversationId;
    if (title.textContent === "新对话") title.textContent = (message || "图片对话").slice(0, 40);
    await loadConversations();
  } catch (error) {
    if (!pending.textContent || pending.textContent === "正在思考...") pending.closest(".message").remove();
    addError(error.message || "未知错误");
    input.value = message;
    attachments = outgoingAttachments;
    renderAttachments();
  } finally {
    send.disabled = false;
    input.focus();
  }
});

attach.addEventListener("click", () => fileInput.click());

structuredEnabled.addEventListener("change", () => {
  localStorage.setItem("structuredEnabled", String(structuredEnabled.checked));
});

schemaToggle.addEventListener("click", openSchemaModal);

function closeSchemaModal() {
  schemaModal.hidden = true;
  schemaToggle.focus();
}

schemaSave.addEventListener("click", () => {
  try {
    schemaInput.setCustomValidity("");
    const schema = JSON.parse(schemaInput.value);
    if (!schema || schema.type !== "object" || typeof schema.properties !== "object") throw new Error("根节点必须是包含 properties 的 object");
    savedSchema = JSON.stringify(schema, null, 2);
    localStorage.setItem("structuredSchema", savedSchema);
    closeSchemaModal();
  } catch (error) {
    schemaInput.setCustomValidity(`JSON Schema 无效：${error.message}`);
    schemaInput.reportValidity();
  }
});

schemaModal.addEventListener("click", (event) => {
  if (event.target.closest("[data-schema-close]") || event.target.id === "schema-cancel") closeSchemaModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !schemaModal.hidden) closeSchemaModal();
});

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files].filter((file) => file.type.startsWith("image/") || isTextFile(file)).slice(0, 4 - attachments.length);
  try {
    attach.disabled = true;
    const next = await Promise.all(files.map((file) => file.type.startsWith("image/") ? compressImage(file) : readTextFile(file)));
    attachments = [...attachments, ...next].slice(0, 4);
    renderAttachments();
  } catch (error) {
    addError(error.message || "无法处理附件");
  } finally {
    fileInput.value = "";
    attach.disabled = false;
  }
});

attachmentsView.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  attachments.splice(Number(button.dataset.remove), 1);
  renderAttachments();
});

input.addEventListener("keydown", (event) => {
  if (!commandMenu.hidden) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      activeCommandIndex = (activeCommandIndex + direction + visibleCommands.length) % visibleCommands.length;
      renderCommandMenu();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandMenu();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      executeCommand(visibleCommands[activeCommandIndex].name);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  activeCommandIndex = 0;
  renderCommandMenu();
});

commandMenu.addEventListener("mousedown", (event) => {
  const option = event.target.closest("[data-command]");
  if (!option) return;
  event.preventDefault();
  executeCommand(option.dataset.command);
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#composer")) closeCommandMenu();
});

list.addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    removeConversation(deleteButton.dataset.delete);
    return;
  }
  const button = event.target.closest("[data-id]");
  if (button) openConversation(button.dataset.id);
});
document.querySelector("#new-chat").addEventListener("click", newChat);

await loadConversations();
if (conversationId) await openConversation(conversationId);
input.focus();
