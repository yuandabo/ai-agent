import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_TIMEOUT = 30_000;

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function expandEnv(value, environment = process.env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => environment[name] || "");
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item, environment));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item, environment)]));
  }
  return value;
}

function openAiTool(serverName, tool) {
  return {
    type: "function",
    function: {
      name: `mcp__${safeName(serverName)}__${safeName(tool.name)}`,
      description: `[MCP: ${serverName}] ${tool.description || tool.name}`,
      parameters: tool.inputSchema || { type: "object", properties: {} }
    }
  };
}

export class McpManager {
  constructor(configPath = process.env.MCP_CONFIG || "mcp.json") {
    this.configPath = resolve(configPath);
    this.connections = new Map();
    this.toolRoutes = new Map();
    this.tools = [];
    this.serverStatuses = new Map();
  }

  async connect() {
    let config;
    try {
      config = JSON.parse(await readFile(this.configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error(`Unable to read MCP config ${this.configPath}: ${error.message}`);
    }

    for (const [serverName, rawConfig] of Object.entries(config.servers || {})) {
      if (rawConfig?.enabled === false) {
        this.serverStatuses.set(serverName, { name: serverName, status: "disabled", transport: rawConfig.transport || "stdio", toolCount: 0, tools: [] });
        continue;
      }
      this.serverStatuses.set(serverName, { name: serverName, status: "connecting", transport: rawConfig.transport || "stdio", toolCount: 0, tools: [] });
      try {
        const environment = { ...process.env };
        if (rawConfig.envFile) {
          const envPath = resolve(dirname(this.configPath), rawConfig.envFile);
          Object.assign(environment, parseEnv(await readFile(envPath, "utf8")));
        }
        const serverConfig = expandEnv(rawConfig, environment);
        if (serverConfig.bearerTokenEnvVar) {
          const token = environment[serverConfig.bearerTokenEnvVar];
          if (!token) throw new Error(`Missing bearer token environment variable: ${serverConfig.bearerTokenEnvVar}`);
          serverConfig.headers = { ...serverConfig.headers, Authorization: `Bearer ${token}` };
        }
        await this.connectServer(serverName, serverConfig);
      } catch (error) {
        this.serverStatuses.set(serverName, {
          name: serverName,
          status: "error",
          transport: rawConfig.transport || "stdio",
          toolCount: 0,
          tools: [],
          error: error.message
        });
        console.error(`[MCP] ${serverName} connection failed: ${error.message}`);
      }
    }
    return this.tools;
  }

  async connectServer(serverName, config) {
    const client = new Client({ name: "local-ai-agent", version: "1.0.0" });
    let transport;
    if (config.transport === "http") {
      if (!config.url) throw new Error("HTTP transport requires url");
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers || {} }
      });
    } else {
      if (!config.command) throw new Error("stdio transport requires command");
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        cwd: config.cwd ? resolve(config.cwd) : process.cwd(),
        env: { ...process.env, ...(config.env || {}) },
        stderr: "inherit"
      });
    }

    await client.connect(transport);
    const result = await client.listTools({}, { timeout: config.timeoutMs || DEFAULT_TIMEOUT });
    this.connections.set(serverName, { client, timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT });
    for (const tool of result.tools) {
      const exposed = openAiTool(serverName, tool);
      this.tools.push(exposed);
      this.toolRoutes.set(exposed.function.name, { serverName, toolName: tool.name });
    }
    this.serverStatuses.set(serverName, {
      name: serverName,
      status: "connected",
      transport: config.transport || "stdio",
      toolCount: result.tools.length,
      tools: result.tools.map((tool) => tool.name)
    });
    console.log(`[MCP] ${serverName} connected (${result.tools.length} tools)`);
  }

  getStatus() {
    return [...this.serverStatuses.values()].map((status) => ({ ...status, tools: [...status.tools] }));
  }

  ownsTool(name) {
    return this.toolRoutes.has(name);
  }

  async callTool(name, args) {
    const route = this.toolRoutes.get(name);
    if (!route) return { ok: false, error: `Unknown MCP tool: ${name}` };
    const connection = this.connections.get(route.serverName);
    try {
      const result = await connection.client.callTool(
        { name: route.toolName, arguments: args },
        undefined,
        { timeout: connection.timeoutMs }
      );
      return {
        ok: !result.isError,
        server: route.serverName,
        tool: route.toolName,
        content: result.content,
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {})
      };
    } catch (error) {
      return { ok: false, server: route.serverName, tool: route.toolName, error: error.message };
    }
  }

  async close() {
    await Promise.allSettled([...this.connections.values()].map(({ client }) => client.close()));
    this.connections.clear();
    this.toolRoutes.clear();
    this.tools = [];
  }
}
