# Local AI Agent

## MCP Client

The agent loads optional MCP servers from `mcp.json`. MCP tools are discovered at startup and exposed to the model with names such as `mcp__filesystem__read_text_file`, alongside the built-in tools.

The included configuration starts the official filesystem MCP Server over stdio and restricts it to `workspace/`. Verify the real MCP connection, tool discovery, directory listing, and file reading with:

```powershell
npm run test:mcp
```

Set `MCP_CONFIG` to use another configuration file. Streamable HTTP servers use this shape:

```json
{
  "servers": {
    "remote": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

For bearer-token authentication without storing secrets in `mcp.json`, use `envFile` and `bearerTokenEnvVar`:

```json
{
  "transport": "http",
  "url": "http://127.0.0.1:3100/mcp",
  "envFile": "../mcp/.env",
  "bearerTokenEnvVar": "SIMPLE_MCP_API_KEY"
}
```

一个基于 Node.js 和 OpenAI 兼容 `Chat Completions API` 的本地 AI Agent。项目集成了流式回复、Tool Calling、多模态附件、本地记忆、长上下文管理、RAG 和 JSON Schema 结构化输出，并提供轻量 Web 测试页面。

## 功能

- 流式回复：解析上游 SSE，并通过 NDJSON 实时推送到浏览器。
- Tool Calling：支持读取、写入、搜索和管理 `workspace/` 内的文件。
- MCP Client：支持 stdio 与 Streamable HTTP，启动时自动发现并注册远程工具。
- 多模态输入：支持图片以及常见纯文本附件。
- 本地记忆：使用 SQLite 保存会话、消息、摘要和工具调用记录。
- 长上下文管理：组合滑动窗口、增量摘要和历史消息 RAG。
- 结构化输出：可配置 JSON Schema，要求模型返回可解析 JSON。
- 会话管理：浏览历史会话，并完整删除关联消息、工具记录和检索索引。
- 斜杠指令：在输入框输入 `/`，通过键盘或鼠标执行本地快捷操作和 MCP 状态查询。

## 环境要求

- Node.js 22.5 或更高版本（项目使用内置 `node:sqlite`）。
- OpenAI API，或兼容 `/chat/completions` 的中转站。
- 所选模型需要支持项目中实际使用的能力，例如 Tool Calling、图片输入和 JSON Schema。

## 快速开始

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`：

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your_model
```

启动 Web 页面：

```powershell
npm run web
```

访问 [http://localhost:3001](http://localhost:3001)。也可以使用命令行入口：

```powershell
npm start -- "你好"
```

## 斜杠指令

在聊天输入框输入 `/` 会打开指令菜单。菜单支持继续输入过滤、上下方向键选择、`Enter` 执行、`Esc` 关闭以及鼠标点击。

| 指令 | 用途 |
| --- | --- |
| `/mcp` | 查看所有 MCP Server 的连接状态、传输方式和工具数量 |
| `/tools` | 查看当前可用的 MCP 工具列表 |
| `/new` | 新建对话 |
| `/clear` | 清空当前输入 |
| `/schema` | 打开 JSON Schema 配置 |
| `/help` | 显示全部斜杠指令 |

`/mcp` 和 `/tools` 通过 `GET /api/mcp/status` 获取实时状态，其余指令在浏览器本地执行，不会作为聊天消息发送给模型。状态接口不会返回 MCP 密钥或请求头。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | API 密钥，必填 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容接口地址 |
| `OPENAI_MODEL` | `gpt-5.5` | 模型名称 |
| `HTTPS_PROXY` | 空 | 可选 HTTP 代理 |
| `AGENT_DATA_DIR` | `data` | SQLite 数据目录 |
| `AGENT_WORKSPACE` | `workspace` | 文件工具沙箱目录 |
| `AGENT_CONTEXT_CHARS` | `24000` | 近期上下文字符预算 |
| `AGENT_RAG_CHARS` | `5000` | RAG 召回字符预算 |
| `AGENT_RAG_LIMIT` | `5` | RAG 最大召回消息数，设为 `0` 可关闭 |
| `AGENT_MAX_IMAGE_BYTES` | `4194304` | 服务端单张图片大小限制 |
| `WEB_PORT` | `3001` | Web 服务端口 |

## 文件工具

Agent 目前提供以下工具：

- `read_file`：读取 UTF-8 文本文件。
- `write_file`：写入文本文件并自动创建父目录。
- `list_directory`：列出目录内容。
- `file_info`：获取文件或目录信息。
- `search_text`：递归搜索文本内容。
- `create_directory`：创建目录。

所有路径必须是 `workspace/` 内的相对路径。Agent 会拒绝访问 `.env`、`.git`、`node_modules` 以及沙箱之外的路径。

## 上下文与 RAG

每轮请求按以下方式构建上下文：

1. 固定系统提示和工具定义。
2. 较早对话的长期摘要。
3. 根据当前问题从窗口外历史中召回的相关消息。
4. 最近对话的原始消息滑动窗口。

当前 RAG 使用 SQLite 持久化索引和本地字符串片段相关性评分，不依赖 Embedding 服务。它只检索当前会话，适合本地 MVP；高规模或跨文档检索可进一步升级为关键词与向量混合检索。

## 中转站兼容性

不同中转站可能只兼容部分 OpenAI 请求格式。建议分别验证：

- 普通文本和 `stream: true`。
- `tools`、`tool_choice` 和流式 `tool_calls`。
- `content` 数组及 `image_url` Base64 图片。
- `response_format.type = json_schema`。

如果图片可上传但无法识别，或结构化输出报错，通常是当前模型或中转站未透传对应字段。

## 开发命令

```powershell
npm run check       # JavaScript 语法检查
npm test            # 测试 API 连接
npm run test:mcp    # 验证官方 filesystem MCP Server
npm run web         # 启动 Web 页面
npm start -- "问题" # 使用 CLI Agent
```

本地 `.env`、SQLite 数据库、`workspace/` 和依赖目录均不会提交到 Git。
