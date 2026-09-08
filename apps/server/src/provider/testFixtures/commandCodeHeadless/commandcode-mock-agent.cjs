#!/usr/bin/env node
/**
 * commandcode-mock-agent.cjs — scriptable stand-in for `command-code -p`.
 *
 * Reads the piped prompt, then emits the same NDJSON frame family the real
 * CLI emits, so adapter tests can run without an installed Command Code.
 * Behavior knobs (env):
 *   T3_MOCK_ARGV_LOG  path to write the received argv as JSON
 *   T3_MOCK_SESSION   session id to report (default "mock-session-1")
 *   T3_MOCK_HANG=1    stop emitting after the first message chunk and hold
 *                     the process open until killed (interrupt tests)
 */
"use strict";

const fs = require("node:fs");

const sessionId = process.env.T3_MOCK_SESSION || "mock-session-1";
const argvLogPath = process.env.T3_MOCK_ARGV_LOG;
const hang = process.env.T3_MOCK_HANG === "1";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (argvLogPath) {
    fs.writeFileSync(argvLogPath, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  }

  const usage = {
    inputTokens: 21869,
    outputTokens: 3,
    cacheReadTokens: 5376,
    cacheWriteTokens: 0,
  };
  const emit = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

  emit({ type: "event", event: { type: "run_start", sessionId } });
  emit({ type: "event", event: { type: "turn_start", turnNumber: 1 } });
  emit({ type: "event", event: { type: "message_start" } });
  emit({ type: "event", event: { type: "text_delta", delta: "Hola" } });

  if (hang) {
    // Keep the process alive briefly: emit nothing more until the test kills
    // us. If the kill does not reach the node process, this bounds the wait.
    process.stdout.write("", () => {
      setTimeout(() => {
        process.exit(0);
      }, 4_000);
    });
    return;
  }

  emit({ type: "event", event: { type: "text_delta", delta: ", mundo" } });
  emit({
    type: "event",
    event: { type: "message_update", content: [{ type: "text", text: "Hola, mundo" }] },
  });
  emit({
    type: "event",
    event: {
      type: "model_request_end",
      model: "deepseek/deepseek-v4-flash",
      usage,
      stopReason: "stop",
    },
  });
  emit({
    type: "event",
    event: { type: "message_end", content: [{ type: "text", text: "Hola, mundo" }] },
  });
  emit({ type: "event", event: { type: "turn_end", turnNumber: 1, hadToolCalls: false, usage } });
  emit({
    type: "event",
    event: {
      type: "run_end",
      result: { finalText: "Hola, mundo", stopReason: "end_turn", turnCount: 1, usage },
    },
  });
  emit({
    type: "result",
    subtype: "success",
    sessionId,
    stopReason: "end_turn",
    usage,
    durationMs: 10,
    finalText: "Hola, mundo",
  });
});
