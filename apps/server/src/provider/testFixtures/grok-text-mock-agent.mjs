// Native Grok's v1 model-selection wire contract, kept independent of the v2 mock.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "grok-text-session";
let currentModelId = "grok-mock-default";
const models = ["grok-mock-default", "grok-mock-alt"];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.T3_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
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
      result = { stopReason: "end_turn" };
      break;
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
