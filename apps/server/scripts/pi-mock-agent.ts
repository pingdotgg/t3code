#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
//
// pi-mock-agent.ts — a scripted stand-in for the `pi --mode rpc` binary used
// by the PiAgent adapter tests. The real pi binary is not installed in CI or
// on contributor machines, so the adapter tests spawn this script through a
// tiny shell wrapper and drive it through the same JSONL-over-stdio protocol
// the adapter speaks to real pi.
//
// Behavior is selected with T3_PI_* environment variables; see each flag
// below. Unset flags produce a minimal happy-path agent that answers a
// prompt with one text delta and settles.

import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const sessionId = process.env.T3_PI_SESSION_ID ?? "mock-pi-session-1";
const sessionName = process.env.T3_PI_SESSION_NAME ?? "mock-pi-session-name";
const requestLogPath = process.env.T3_PI_REQUEST_LOG_PATH;
const exitLogPath = process.env.T3_PI_EXIT_LOG_PATH;
const hangPromptForever = process.env.T3_PI_HANG_PROMPT_FOREVER === "1";
const failPrompt = process.env.T3_PI_FAIL_PROMPT === "1";
const emitToolCalls = process.env.T3_PI_EMIT_TOOL_CALLS === "1";
const emitThinking = process.env.T3_PI_EMIT_THINKING === "1";
const emitConfirm = process.env.T3_PI_EMIT_CONFIRM === "1";
const emitSelect = process.env.T3_PI_EMIT_SELECT === "1";
const emitInput = process.env.T3_PI_EMIT_INPUT === "1";
const emitNotify = process.env.T3_PI_EMIT_NOTIFY === "1";
const emitExtensionError = process.env.T3_PI_EMIT_EXTENSION_ERROR === "1";
const emitWillRetry = process.env.T3_PI_EMIT_AGENT_END_WITH_RETRY === "1";
const exitOnStart = process.env.T3_PI_EXIT_ON_START === "1";
const promptResponseText = process.env.T3_PI_PROMPT_RESPONSE_TEXT ?? "hello from mock pi";
const requestedModel = process.env.T3_PI_MODEL_ID ?? "claude-sonnet-4-6";
const settleDelayMs = Number(process.env.T3_PI_DELAY_SETTLE_MS ?? "0");

let currentModel = requestedModel;
let currentThinkingLevel = "medium";
let isStreaming = false;

const pendingUi: Array<{ id: string; method: string; promise: Promise<void> }> = [];

function writeRecord(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function logExit(reason: string): void {
  if (!exitLogPath) return;
  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

function logRequest(request: Record<string, unknown>): void {
  if (!requestLogPath) return;
  NodeFS.appendFileSync(requestLogPath, `${JSON.stringify(request)}\n`, "utf8");
}

function response(command: string, id: string | undefined, data?: unknown, error?: string): void {
  writeRecord({
    type: "response",
    command,
    success: error === undefined,
    ...(data !== undefined ? { data } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(id !== undefined ? { id } : {}),
  });
}

function emitAgentStart(): void {
  writeRecord({ type: "agent_start" });
}

function emitAgentEnd(): void {
  writeRecord({
    type: "agent_end",
    messages: [{ id: "mock-msg-1", role: "assistant", content: promptResponseText }],
    willRetry: emitWillRetry,
  });
}

function emitAgentSettled(): void {
  isStreaming = false;
  writeRecord({ type: "agent_settled" });
}

function emitMessageTurn(): void {
  writeRecord({ type: "message_start", message: { id: "mock-msg-1", role: "assistant" } });
  if (emitThinking) {
    writeRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    });
    writeRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "mock thinking" },
    });
    writeRecord({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end" },
    });
  }
  writeRecord({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: promptResponseText },
  });
  writeRecord({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0 },
  });
  writeRecord({
    type: "message_end",
    message: {
      id: "mock-msg-1",
      role: "assistant",
      content: promptResponseText,
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  });
}

function emitMockToolCalls(): void {
  writeRecord({
    type: "tool_execution_start",
    toolCallId: "mock-call-1",
    toolName: "bash",
    args: { command: "ls" },
  });
  writeRecord({
    type: "tool_execution_update",
    toolCallId: "mock-call-1",
    partialResult: "file.txt",
  });
  writeRecord({
    type: "tool_execution_end",
    toolCallId: "mock-call-1",
    toolName: "bash",
    result: "file.txt",
    isError: false,
  });
}

function emitExtensionUi(): void {
  if (emitConfirm) {
    writeRecord({
      type: "extension_ui_request",
      id: "mock-ui-confirm",
      method: "confirm",
      title: "Approve command",
      message: "Run `ls`?",
    });
  }
  if (emitSelect) {
    writeRecord({
      type: "extension_ui_request",
      id: "mock-ui-select",
      method: "select",
      title: "Choose scope",
      message: "Which scope?",
      options: [
        { value: "workspace", label: "Workspace" },
        { value: "project", label: "Project" },
      ],
    });
  }
  if (emitInput) {
    writeRecord({
      type: "extension_ui_request",
      id: "mock-ui-input",
      method: "input",
      title: "Free text",
      message: "Type something",
    });
  }
  if (emitNotify) {
    writeRecord({
      type: "extension_ui_request",
      id: "mock-ui-notify",
      method: "notify",
      title: "Heads up",
      message: "A notification",
    });
  }
}

function handlePrompt(request: Record<string, unknown>): void {
  const id = typeof request.id === "string" ? request.id : undefined;
  // A steer prompt arrives while a run is in flight; pi folds it into the
  // ongoing run, so ack it without emitting a second set of turn events.
  if (isStreaming) {
    response("prompt", id, { ok: true, steered: true });
    return;
  }
  isStreaming = true;
  emitAgentStart();
  emitExtensionUi();
  if (emitExtensionError) {
    writeRecord({ type: "extension_error", message: "mock extension failure" });
    response("prompt", id, undefined, "extension_error");
    isStreaming = false;
    return;
  }
  if (failPrompt) {
    response("prompt", id, undefined, "mock prompt failure");
    isStreaming = false;
    return;
  }
  if (hangPromptForever) {
    // Ack the prompt but never emit agent events; the test aborts, and the
    // abort handler below settles the run.
    response("prompt", id, { ok: true });
    return;
  }
  emitMockToolCalls();
  writeRecord({ type: "turn_start" });
  emitMessageTurn();
  writeRecord({ type: "turn_end", message: { id: "mock-msg-1" }, toolResults: [] });
  // Ack the prompt immediately; the agent keeps working until it settles
  // (settleDelayMs is only about agent_end/agent_settled).
  response("prompt", id, { ok: true });
  setTimeout(() => {
    emitAgentEnd();
    emitAgentSettled();
  }, settleDelayMs);
}

function handleAbort(): void {
  if (isStreaming) {
    emitAgentEnd();
    emitAgentSettled();
    isStreaming = false;
  }
  response("abort", undefined, { aborted: true });
}

async function run(): Promise<void> {
  if (exitOnStart) {
    logExit("exited-on-start");
    process.exit(0);
  }

  // Log the signal that terminated us so the adapter's stop-session test
  // can assert the child was killed rather than left running.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      logExit(signal);
      process.exit(0);
    });
  }

  const rl = NodeReadline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void handleLine(line);
  });
  rl.on("close", () => {
    logExit("stdin-closed");
    process.exit(0);
  });

  async function handleLine(line: string): Promise<void> {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    logRequest(request);
    const type = request.type;
    const requestId = typeof request.id === "string" ? request.id : undefined;

    if (type === "get_state") {
      response("get_state", requestId, {
        model: currentModel,
        thinkingLevel: currentThinkingLevel,
        isStreaming,
        sessionFile: `sessions/${sessionId}.jsonl`,
        sessionId,
        sessionName,
      });
      return;
    }
    if (type === "get_available_models") {
      response("get_available_models", requestId, {
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            api: "anthropic",
            provider: "anthropic",
            baseUrl: null,
            reasoning: true,
            input: 0,
            contextWindow: 200000,
            maxTokens: 64000,
            cost: null,
          },
          {
            id: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            api: "anthropic",
            provider: "anthropic",
            baseUrl: null,
            reasoning: false,
            input: 0,
            contextWindow: 200000,
            maxTokens: 32000,
            cost: null,
          },
          {
            id: "gpt-5",
            name: "GPT-5",
            api: "openai",
            provider: "openai",
            baseUrl: null,
            reasoning: true,
            input: 0,
            contextWindow: 400000,
            maxTokens: 128000,
            cost: null,
          },
        ],
      });
      return;
    }
    if (type === "prompt") {
      void handlePrompt(request);
      return;
    }
    if (type === "abort") {
      handleAbort();
      return;
    }
    if (type === "set_model") {
      currentModel = typeof request.modelId === "string" ? request.modelId : currentModel;
      response("set_model", requestId, { model: currentModel });
      return;
    }
    if (type === "set_thinking_level") {
      currentThinkingLevel =
        typeof request.level === "string" ? request.level : currentThinkingLevel;
      response("set_thinking_level", requestId, { level: currentThinkingLevel });
      return;
    }
    if (type === "set_session_name") {
      response("set_session_name", requestId, {});
      return;
    }
    if (type === "get_session_stats") {
      response("get_session_stats", requestId, {
        tokens: { input: 100, output: 50 },
        cost: 0.01,
        contextUsage: { usedTokens: 150, maxTokens: 200000 },
      });
      return;
    }
    if (type === "get_messages") {
      response("get_messages", requestId, {
        messages: [
          { id: "mock-user-1", role: "user", content: "hello" },
          { id: "mock-msg-1", role: "assistant", content: promptResponseText },
        ],
      });
      return;
    }
    if (
      type === "switch_session" ||
      type === "new_session" ||
      type === "get_entries" ||
      type === "get_commands"
    ) {
      response(String(type), requestId, {});
      return;
    }
    if (type === "extension_ui_response") {
      // Fire-and-forget; pi does not ack extension UI responses.
      return;
    }

    response(String(type), requestId, {});
  }
}

run().catch((error) => {
  logExit(`mock-pi-error: ${String(error)}`);
  process.exit(1);
});
