import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";

// Captured from ACP 1.4.0 session/new with personal Google authentication.
export const antigravity140Session = {
  sessionId: "047c62f6-607b-44db-bfbe-f83b67e9e8b1",
  models: {
    currentModelId: "gemini-3.8-flash-high",
    availableModels: [
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-3.8-flash",
      options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
    },
    {
      id: "thinking_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
} satisfies AcpSchema.NewSessionResponse;

// Native v1 framing follows provider/testFixtures/grok-text-mock-agent.mjs.
export const antigravity140AgentSource = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const setup = ${JSON.stringify(antigravity140Session)};
let sessionId = setup.sessionId;
let modelId = setup.models.currentModelId;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (update) => write({
  jsonrpc: "2.0", method: "session/update", params: { sessionId, update },
});
const configOptions = () => setup.configOptions.map((option) =>
  option.id === "thinking_level"
    ? { ...option, currentValue: modelId.split("-").at(-1) }
    : option,
);

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, line + "\\n");
  if (request.id === undefined) continue;
  let result = {};
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version: "1.4.0" },
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      };
      break;
    case "authenticate":
    case "session/set_mode":
      break;
    case "session/new":
      result = { ...setup, configOptions: configOptions() };
      break;
    case "session/resume":
      sessionId = request.params.sessionId;
      result = { models: setup.models, configOptions: configOptions() };
      break;
    case "session/set_model":
      if (!setup.models.availableModels.some((model) => model.modelId === request.params.modelId)) {
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown model" } });
        continue;
      }
      modelId = request.params.modelId;
      update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
      break;
    case "session/set_config_option":
      if (request.params.configId === "mode") {
        result = { configOptions: configOptions() };
        break;
      }
      if (request.params.configId !== "thinking_level") {
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Expected thinking level" } });
        continue;
      }
      modelId = "gemini-3.8-flash-" + request.params.value;
      result = { configOptions: configOptions() };
      update({ sessionUpdate: "config_option_update", ...result });
      break;
    case "session/prompt":
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: process.env.T3_ACP_TITLE === "1" ? JSON.stringify({ title: modelId }) : modelId },
      });
      result = { stopReason: "end_turn" };
      break;
    default:
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      continue;
  }
  write({ jsonrpc: "2.0", id: request.id, result });
}
`;

export const decodeAntigravity140Request = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optional(Schema.Struct({ modelId: Schema.optional(Schema.String) })),
    }),
  ),
);
