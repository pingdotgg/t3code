// Grok's model and effort wire contract (grok 1.0.41): per-model efforts on `models`, a
// `thought_level` option `reasoning_effort`, and `config_option_update` after set_model.
// T3_GROK_MOCK_PROTOCOL picks the protocol (default 1); T3_GROK_MOCK_REJECT_EFFORT names
// an advertised effort Grok refuses.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = "grok-model-selection-session";
const protocolVersion = Number(process.env.T3_GROK_MOCK_PROTOCOL ?? "1");
const rejectedEffort = process.env.T3_GROK_MOCK_REJECT_EFFORT;
const models = {
  "grok-4.6": { efforts: ["xhigh", "high", "medium", "low"], defaultEffort: "xhigh" },
  "grok-4.6-fast": { efforts: ["high", "low"], defaultEffort: "high" },
};
let currentModelId = "grok-4.6";
let currentEffort = models[currentModelId].defaultEffort;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModelId,
    options: Object.keys(models).map((value) => ({ value, name: value })),
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: currentEffort,
    options: models[currentModelId].efforts.map((value) => ({ value, name: value })),
  },
];

// Returns an error message when Grok would refuse the switch.
const switchTo = (modelId, effort) => {
  const model = models[modelId];
  if (model === undefined) return "Unknown Grok model";
  if (effort !== undefined && (effort === rejectedEffort || !model.efforts.includes(effort))) {
    return `Unsupported reasoning effort ${effort}`;
  }
  currentEffort = effort ?? (modelId === currentModelId ? currentEffort : model.defaultEffort);
  currentModelId = modelId;
  return undefined;
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.T3_ACP_REQUEST_LOG_PATH) {
    NodeFS.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
  }
  if (request.id === undefined) continue;
  const fail = (message) =>
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message } });
  let result;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion, agentInfo: { name: "grok", version: "mock" } };
      break;
    case "session/new":
      result = {
        sessionId,
        models: {
          currentModelId,
          availableModels: Object.entries(models).map(([modelId, model]) => ({
            modelId,
            name: modelId,
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: modelId === currentModelId ? currentEffort : model.defaultEffort,
              reasoningEfforts: model.efforts.map((value) => ({ id: value, value, label: value })),
            },
          })),
        },
        configOptions: configOptions(),
      };
      break;
    case "session/set_model": {
      const error = switchTo(request.params.modelId, request.params._meta?.reasoningEffort);
      if (error !== undefined) {
        fail(error);
        continue;
      }
      write({ jsonrpc: "2.0", id: request.id, result: {} });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
        },
      });
      continue;
    }
    case "session/set_config_option": {
      const { configId, value } = request.params;
      const error =
        configId === "model"
          ? switchTo(value, undefined)
          : configId === "reasoning_effort"
            ? switchTo(currentModelId, value)
            : `Unknown config option ${configId}`;
      if (error !== undefined) {
        fail(error);
        continue;
      }
      result = { configOptions: configOptions() };
      break;
    }
    case "session/prompt":
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
