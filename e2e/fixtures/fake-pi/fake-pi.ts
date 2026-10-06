// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - stdlib-only fake CLI, outside any Effect runtime.
/**
 * Deterministic stand-in for the Pi CLI, which the server drives with `--mode rpc` over
 * JSONL on stdio. Pi publishes no typed protocol, so frames follow the recordings in
 * apps/server/src/orchestration-v2/testkit/fixtures/*\/pi_transcript.ndjson, and the e2e
 * provider tests are what catch drift. Prompts follow ../scenario.ts.
 *
 * Real Pi asks for approval through T3's injected extension; the fake asks itself when
 * the server launches it with `T3_PI_RUNTIME_MODE=approval-required`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

import {
  WAITING_TEXT,
  replyText,
  scenarioFor,
  writeCommand,
  writeScenarioFile,
} from "../scenario.ts";

const VERSION = "1.0.0";
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
} else {
  runRpc();
}

/** Serves Pi's JSONL RPC: id-correlated commands, plus id-less events and prompts. */
function runRpc() {
  const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const respond = (command: string, id: string | undefined, data?: unknown) =>
    write({
      ...(id === undefined ? {} : { id }),
      type: "response",
      command,
      success: true,
      ...(data === undefined ? {} : { data }),
    });
  const approvalRequired = process.env.T3_PI_RUNTIME_MODE === "approval-required";
  const sessionId = NodeCrypto.randomUUID();
  const model = {
    type: "chat",
    id: "fake-model",
    name: "Fake Pi Model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    provider: "fake",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const entries: Array<{ id: string }> = [];
  const pendingConfirms = new Map<string, (confirmed: boolean) => void>();
  let streaming = false;
  let aborted = false;
  let lastAssistantText = "";

  const state = () => ({
    model,
    thinkingLevel: "off",
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionFile: `/fake-pi/${sessionId}.jsonl`,
    sessionId,
    autoCompactionEnabled: true,
    messageCount: entries.length,
    pendingMessageCount: 0,
  });

  const message = (role: "user" | "assistant", text: string) => ({
    role,
    content: [{ type: "text", text }],
    ...(role === "assistant"
      ? { api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop" }
      : {}),
    timestamp: Date.now(),
  });

  const settle = () => {
    streaming = false;
    write({ type: "agent_end", messages: [] });
    write({ type: "agent_settled" });
  };

  const say = (text: string) => {
    lastAssistantText = text;
    const assistant = message("assistant", text);
    write({ type: "message_start", message: { ...assistant, content: [], stopReason: "pending" } });
    write({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    write({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    });
    write({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
    });
    write({ type: "message_end", message: assistant });
    write({ type: "turn_end", message: assistant, toolResults: [] });
    entries.push({ id: NodeCrypto.randomUUID().slice(0, 8) });
  };

  const confirm = (title: string, detail: string) =>
    new Promise<boolean>((resolve) => {
      const id = NodeCrypto.randomUUID();
      pendingConfirms.set(id, resolve);
      write({ type: "extension_ui_request", id, method: "confirm", title, message: detail });
    });

  const runPrompt = async (text: string) => {
    streaming = true;
    aborted = false;
    write({ type: "agent_start" });
    write({ type: "turn_start" });
    const user = message("user", text);
    write({ type: "message_start", message: user });
    write({ type: "message_end", message: user });
    entries.push({ id: NodeCrypto.randomUUID().slice(0, 8) });
    const scenario = scenarioFor(text);
    if (scenario.kind === "wait") {
      say(WAITING_TEXT);
      return;
    }
    if (scenario.kind === "reply") {
      say(replyText("Pi", text));
      settle();
      return;
    }
    const { fileName } = scenario;
    const allowed = !approvalRequired || (await confirm("Allow bash?", writeCommand(fileName)));
    if (aborted) return;
    const cwd = process.cwd();
    if (allowed) writeScenarioFile(cwd, fileName);
    say(allowed ? `Wrote ${fileName}.` : `Okay, I did not write ${fileName}.`);
    settle();
  };

  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const frame: { type: string; id?: string; message?: string; confirmed?: boolean } =
      JSON.parse(line);
    switch (frame.type) {
      case "get_state":
        respond("get_state", frame.id, state());
        return;
      case "get_commands":
        respond("get_commands", frame.id, { commands: [] });
        return;
      case "get_available_models":
        respond("get_available_models", frame.id, { models: [model] });
        return;
      case "get_entries":
        respond("get_entries", frame.id, { entries: [], leafId: entries.at(-1)?.id ?? null });
        return;
      case "set_model":
        respond("set_model", frame.id, model);
        return;
      case "get_session_stats":
        respond("get_session_stats", frame.id, {
          sessionFile: state().sessionFile,
          sessionId,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: entries.length,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        });
        return;
      case "get_last_assistant_text":
        respond("get_last_assistant_text", frame.id, { text: lastAssistantText });
        return;
      case "prompt":
        respond("prompt", frame.id, { disposition: "started" });
        void runPrompt(frame.message ?? "");
        return;
      case "abort":
        aborted = true;
        for (const resolve of pendingConfirms.values()) resolve(false);
        pendingConfirms.clear();
        respond("abort", frame.id);
        if (streaming) settle();
        return;
      case "extension_ui_response": {
        const resolve = frame.id === undefined ? undefined : pendingConfirms.get(frame.id);
        if (frame.id !== undefined) pendingConfirms.delete(frame.id);
        resolve?.(frame.confirmed === true);
        return;
      }
      default:
        if (frame.id !== undefined) respond(frame.type, frame.id);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
