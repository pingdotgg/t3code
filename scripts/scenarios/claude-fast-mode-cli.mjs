#!/usr/bin/env node
// A stand-in `claude` binary for claude-fast-mode-notice.e2e.ts: it answers the Agent SDK's
// stream-json protocol and replays the Fast-mode frames Claude Code 2.1.316 sent on two real
// accounts. A first prompt that mentions "credits" plays the overage rejection, any
// other plays an account without extra usage. No model is called.
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("2.1.316 (Claude Code)\n");
  process.exit(0);
}
// Title generation and other one-shot calls: fail, as a CLI without a model would.
if (!argv.includes("stream-json")) {
  process.stderr.write("scenarios run no model\n");
  process.exit(1);
}

const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? NodeCrypto.randomUUID();
const model = flag("--model") ?? "claude-opus-5-5";
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const frame = (fields) => ({ ...fields, session_id: sessionId, uuid: NodeCrypto.randomUUID() });

let overage;
const playTurn = (text) => {
  overage ??= /credits/i.test(text);
  const state = overage
    ? { fast_mode_state: "on" }
    : { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" };
  send(
    frame({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      model,
      tools: [],
      mcp_servers: [],
      permissionMode: flag("--permission-mode") ?? "default",
      slash_commands: [],
      apiKeySource: "none",
      claude_code_version: "2.1.316",
      output_style: "default",
      agents: [],
      skills: [],
      plugins: [],
      ...state,
    }),
  );
  if (overage) {
    send(
      frame({
        type: "system",
        subtype: "notification",
        key: "fast-mode-overage-rejected",
        text: "Fast mode disabled · Out of usage credits",
        priority: "immediate",
      }),
    );
  }
  const reply = "Answered at standard speed.";
  const usage = { input_tokens: 10, output_tokens: 5, speed: "standard" };
  send(
    frame({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: `msg_${NodeCrypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      },
    }),
  );
  send(
    frame({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: reply,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage,
      modelUsage: {},
      permission_denials: [],
      ...state,
    }),
  );
};

const initializeResponse = {
  commands: [],
  agents: [],
  models: [],
  output_style: "default",
  available_output_styles: ["default"],
  account: { email: "scenario@example.invalid", subscriptionType: "max", tokenSource: "claude.ai" },
};
const responses = {
  initialize: initializeResponse,
  mcp_set_servers: { added: [], removed: [], errors: {} },
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: responses[message.request?.subtype] ?? {},
      },
    });
  } else if (message.type === "user") {
    const content = message.message?.content;
    const text =
      typeof content === "string"
        ? content
        : (content ?? []).map((part) => part.text ?? "").join("\n");
    playTurn(text);
  }
}
