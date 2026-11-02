import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "grok-text-session";
let currentModelId = "grok-mock-default";
const models = ["grok-mock-default", "grok-mock-alt"];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const permissionRequestId = 9001;
let pendingPromptId;
const completePrompt = (id) => {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: process.env.T3_ACP_PROMPT_RESPONSE_TEXT ?? "" },
      },
    },
  });
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.T3_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
  }
  if (request.method === undefined) {
    if (request.id === permissionRequestId && pendingPromptId !== undefined) {
      completePrompt(pendingPromptId);
      pendingPromptId = undefined;
    }
    continue;
  }
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "grok", version: "mock" },
        agentCapabilities: {},
      };
      break;
    case "session/new":
      result = {
        sessionId,
        models: {
          currentModelId,
          availableModels: models.map((modelId) => ({ modelId, name: modelId })),
        },
      };
      break;
    case "session/set_model":
      if (!models.includes(request.params.modelId)) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unknown Grok model" },
        });
        continue;
      }
      currentModelId = request.params.modelId;
      result = {};
      break;
    case "session/prompt":
      if (process.env.T3_ACP_REQUEST_PERMISSION) {
        pendingPromptId = request.id;
        write({
          jsonrpc: "2.0",
          id: permissionRequestId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "tool-1", kind: "execute", title: "Run `git status`" },
            options: [
              { optionId: "allow-once", name: "Yes", kind: "allow_once" },
              { optionId: "reject-once", name: "No", kind: "reject_once" },
            ],
          },
        });
        continue;
      }
      completePrompt(request.id);
      continue;
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
