#!/usr/bin/env node
// Stand-in for the Claude Code CLI speaking the Agent SDK's stream-json control
// protocol. It asks one AskUserQuestion and then follows the row named in the
// first prompt (`ROW:<id> TRACE:<dir>`). Driven by
// apps/server/scripts/claude-question-withdrawal-evidence.ts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.0 (Claude Code)\n");
  process.exit(0);
}

const sessionId = NodeCrypto.randomUUID();
const model = "claude-sonnet-4-6";
const usage = { input_tokens: 1, output_tokens: 1 };
const questions = [
  {
    header: "Color",
    question: "Red or Blue?",
    options: [
      { label: "Red", description: "Choose red." },
      { label: "Blue", description: "Choose blue." },
    ],
    multiSelect: false,
  },
];

let row = null;
let traceFile = null;
let traceDir = null;
const pendingTrace = [];
const trace = (entry) => {
  const line = JSON.stringify({ t: performance.timeOrigin + performance.now(), ...entry }) + "\n";
  if (traceFile) NodeFS.appendFileSync(traceFile, line);
  else pendingTrace.push(line);
};
const write = (frame) => {
  trace({ dir: "out", frame });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};
const exit = (code) => {
  trace({ event: "exit", code });
  process.exit(code);
};
process.on("SIGTERM", () => exit(0));

const waiters = new Map();
const waitForResponse = (requestId) => new Promise((resolve) => waiters.set(requestId, resolve));
const waitForFile = (path) =>
  new Promise((resolve) => {
    const poll = setInterval(() => {
      if (NodeFS.existsSync(path)) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });

const initializeResponse = {
  commands: [],
  agents: [],
  models: [],
  output_style: "default",
  available_output_styles: ["default"],
  account: { email: "fixture@example.invalid", subscriptionType: "max", tokenSource: "fixture" },
};

function ask(n) {
  const toolUseId = `toolu_q${n}`;
  const requestId = `cu_q${n}`;
  write({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: NodeCrypto.randomUUID(),
    message: {
      id: `msg_q${n}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage,
    },
  });
  const response = waitForResponse(requestId);
  write({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions },
      tool_use_id: toolUseId,
      permission_suggestions: [],
    },
  });
  return { toolUseId, requestId, response };
}

function finish(toolUseId, decision) {
  const answers = decision?.updatedInput?.answers ?? {};
  write({
    type: "user",
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: NodeCrypto.randomUUID(),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content:
            decision?.behavior === "allow"
              ? `User answered: ${JSON.stringify(answers)}`
              : String(decision?.message ?? "denied"),
        },
      ],
    },
  });
  const text = `Answer received: ${Object.values(answers).join(", ") || "none"}`;
  write({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: NodeCrypto.randomUUID(),
    message: {
      id: "msg_done",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
  });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    stop_reason: "end_turn",
    usage,
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    uuid: NodeCrypto.randomUUID(),
  });
}

async function runTurn(prompt) {
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: process.cwd(),
    tools: ["AskUserQuestion"],
    model,
    permissionMode: "bypassPermissions",
    mcp_servers: [],
    slash_commands: [],
    uuid: NodeCrypto.randomUUID(),
  });
  if (typeof prompt.uuid === "string") {
    write({ type: "command_lifecycle", command_uuid: prompt.uuid, state: "started" });
  }
  const q1 = ask(1);
  switch (row) {
    case "A1":
    case "A2":
      // The adapter interrupts then closes the query; the SDK's cleanup aborts
      // the pending callback, so this process only waits to be shut down.
      return;
    case "A3":
      await waitForFile(NodePath.join(traceDir, `${row}.die`));
      process.stderr.write("fatal: fixture transport failure\n");
      exit(1);
      return;
    case "A4": {
      await waitForFile(NodePath.join(traceDir, `${row}.cancel`));
      write({ type: "control_cancel_request", request_id: q1.requestId });
      await q1.response;
      const q2 = ask(2);
      finish(q2.toolUseId, await q2.response);
      return;
    }
    case "C": {
      const decision = await q1.response;
      // Stale: the SDK already settled this request when it sent the answer.
      write({ type: "control_cancel_request", request_id: q1.requestId });
      finish(q1.toolUseId, decision);
      return;
    }
    default:
      finish(q1.toolUseId, await q1.response);
  }
}

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (row === null && frame.type === "user") {
    const text = JSON.stringify(frame.message?.content ?? "");
    row = /ROW:([A-Z0-9]+)/.exec(text)?.[1] ?? "B";
    traceDir = /TRACE:(\S+?)(?:\\n|\\"|"|\s|$)/.exec(text)?.[1] ?? null;
    if (traceDir) {
      NodeFS.mkdirSync(traceDir, { recursive: true });
      traceFile = NodePath.join(traceDir, `${row}-${process.pid}.ndjson`);
      NodeFS.appendFileSync(traceFile, pendingTrace.splice(0).join(""));
    }
  }
  trace({ dir: "in", frame });
  if (frame.type === "control_response") {
    const requestId = frame.response?.request_id;
    waiters.get(requestId)?.(frame.response?.response);
    waiters.delete(requestId);
    continue;
  }
  if (frame.type === "control_request") {
    const subtype = frame.request?.subtype;
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response:
          subtype === "initialize"
            ? initializeResponse
            : subtype === "mcp_set_servers"
              ? { added: [], removed: [], errors: {} }
              : {},
      },
    });
    continue;
  }
  if (frame.type === "user" && frame.message?.role === "user") {
    void runTurn(frame);
  }
}
exit(0);
