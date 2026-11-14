import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const sessionId = "copilot-text-session";
const scenario = process.env.T3_MOCK_SCENARIO ?? "reply";
const log = (entry) =>
  NodeFS.appendFileSync(process.env.T3_MOCK_LOG, `${JSON.stringify(entry)}\n`, "utf8");
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (value) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const configPath = NodePath.join(process.env.COPILOT_HOME ?? "", "config.json");

log({
  launch: {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    copilotHome: process.env.COPILOT_HOME ?? null,
    copiedConfig: NodeFS.existsSync(configPath) ? NodeFS.readFileSync(configPath, "utf8") : null,
    strippedPresent: ["COPILOT_ALLOW_ALL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"].filter(
      (name) => process.env[name] !== undefined,
    ),
  },
});

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    log({ clientResponse: message });
    continue;
  }
  log({ request: { method: message.method, params: message.params } });
  if (message.id === undefined) continue;
  const respond = (result) => write({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      respond({ protocolVersion: 1, agentInfo: { name: "Copilot", version: "mock" } });
      break;
    case "session/new":
      if (scenario === "auth_required") {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "Authentication required" },
        });
        break;
      }
      respond({ sessionId });
      break;
    case "session/prompt":
      // Open-ended requests stay pending so rejection cannot wait for session/prompt.
      if (scenario === "tool_call" || scenario === "tool_call_completed") {
        update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", status: "pending" });
        if (scenario === "tool_call_completed") {
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"title":"Copilot title"}' },
          });
          respond({ stopReason: "end_turn" });
        }
      } else if (scenario === "permission") {
        write({
          jsonrpc: "2.0",
          id: "permission-1",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "t1", title: "bash" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        });
      } else if (scenario === "read_file") {
        write({
          jsonrpc: "2.0",
          id: "read-1",
          method: "fs/read_text_file",
          params: { sessionId, path: "/etc/hostname" },
        });
      } else if (scenario === "empty" || scenario === "cancelled") {
        respond({ stopReason: scenario === "cancelled" ? "cancelled" : "end_turn" });
      } else if (scenario === "limit_exact" || scenario === "limit_exceeded") {
        const reply = JSON.stringify({ title: "Copilot title" }).padEnd(
          scenario === "limit_exact" ? 128000 : 128001,
          " ",
        );
        for (const part of [reply.slice(0, 64000), reply.slice(64000)])
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
        respond({ stopReason: "end_turn" });
      } else if (scenario === "reply") {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Info: Disabled tools: bash, view\n" },
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ title: "Copilot title" }) },
        });
        respond({ stopReason: "end_turn" });
      } else {
        throw new Error("Unconfigured mock scenario: " + scenario);
      }
      break;
    default:
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not found" } });
  }
}
