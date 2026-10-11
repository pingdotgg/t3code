// A stdio MCP server with two tools, one per `tools/list` page, for
// McpServerTools.test.ts. It writes its pid to MCP_FIXTURE_PID_FILE so the
// test can check that it was stopped, and puts MCP_FIXTURE_GREETING in a tool
// description so the test can check that the server's variables reached it.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

if (process.env.MCP_FIXTURE_PID_FILE) {
  NodeFS.writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
}

const echo = {
  name: "echo",
  title: "Echo",
  description: `Repeats text back. ${process.env.MCP_FIXTURE_GREETING ?? ""}`.trim(),
  inputSchema: {
    type: "object",
    properties: {
      times: { type: "integer", description: "How many times" },
      text: { type: "string", description: "What to repeat" },
    },
    required: ["text"],
  },
};
const pick = {
  name: "pick",
  description: "Picks a color.",
  inputSchema: {
    type: "object",
    properties: {
      color: { type: "string", enum: ["red", "green"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["color"],
  },
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  switch (request.method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "two-tool-fixture", version: "1.2.3" },
        },
      });
      break;
    case "tools/list":
      write({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.params?.cursor === "page-2"
            ? { tools: [pick] }
            : { tools: [echo], nextCursor: "page-2" },
      });
      break;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
}
