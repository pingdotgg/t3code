import * as NodeReadline from "node:readline";

// Inert protocol replay. No provider executable, settings, hooks or network.
const [mode, requestedId] = process.argv.slice(2);
const startupId = "00000000-0000-4000-8000-000000000934";
let prompts = 0;
let initializeRequest;
const write = (message, callback) => process.stdout.write(JSON.stringify(message) + "\n", callback);
const replyInitialized = () => {
  write({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: initializeRequest.request_id,
      response: { commands: [], models: [], agents: [], account: {}, output_style: "default" },
    },
  });
};
const rejectMissing = () => {
  // Native resume validation precedes initialize and has not bound requestedId.
  write(
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      stop_reason: null,
      session_id: startupId,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-8000-000000000001",
      errors: [`No conversation found with session ID: ${requestedId}`],
    },
    () => process.exit(1),
  );
};
process.on("message", (message) => {
  if (message === "inspect") process.send?.({ type: "state", prompts });
  if (message === "initialize") replyInitialized();
  if (message === "missing") rejectMissing();
});
const input = NodeReadline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (mode === "missing") return;
  const message = JSON.parse(line);
  if (message.type === "user") {
    prompts++;
    process.send?.({ type: "prompt", prompts, message: message.message });
    return;
  }
  if (message.type !== "control_request") return;
  if (message.request.subtype !== "initialize") {
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {},
      },
    });
    return;
  }
  initializeRequest = message;
  process.send?.({ type: "initializing", prompts });
  if (mode === "pending") return;
  if (mode === "control-error") {
    write({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: message.request_id,
        error: "Synthetic initialize rejected",
      },
    });
    return;
  }
  replyInitialized();
});
input.on("close", () => process.exit(0));

if (mode === "missing") rejectMissing();
