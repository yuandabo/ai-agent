import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpManager } from "./mcp-client.js";

const workspace = resolve(process.env.AGENT_WORKSPACE || "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(resolve(workspace, "mcp-verification.txt"), "MCP filesystem verification succeeded.\n", "utf8");

const manager = new McpManager();
try {
  const tools = await manager.connect();
  const listTool = tools.find((tool) => tool.function.name.endsWith("__list_directory"));
  const readTool = tools.find((tool) => tool.function.name.endsWith("__read_text_file"));
  if (!listTool || !readTool) throw new Error("filesystem MCP tools were not discovered");

  const listed = await manager.callTool(listTool.function.name, { path: workspace });
  const read = await manager.callTool(readTool.function.name, { path: resolve(workspace, "mcp-verification.txt") });
  if (!listed.ok || !read.ok) throw new Error(JSON.stringify({ listed, read }));

  console.log(JSON.stringify({
    ok: true,
    discoveredTools: tools.length,
    listDirectory: listed.content,
    readTextFile: read.content
  }, null, 2));
} finally {
  await manager.close();
}
