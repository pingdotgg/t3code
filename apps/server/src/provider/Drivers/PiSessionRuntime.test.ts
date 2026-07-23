// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makePiJsonlDecoder, makePiSessionRuntime } from "./PiSessionRuntime.ts";

describe("Pi RPC JSONL decoder", () => {
  it("uses LF as the only record delimiter", () => {
    const decoder = makePiJsonlDecoder();

    expect(decoder.push('{"message":"first\u2028still first"}\n{"message":"sec')).toEqual([
      '{"message":"first\u2028still first"}',
    ]);
    expect(decoder.push('ond"}\r\n')).toEqual(['{"message":"second"}']);
    expect(decoder.end()).toEqual([]);
  });

  it("returns one unterminated final record only when the stream ends", () => {
    const decoder = makePiJsonlDecoder();

    expect(decoder.push('{"type":"agent_settled"}')).toEqual([]);
    expect(decoder.end()).toEqual(['{"type":"agent_settled"}']);
    expect(decoder.end()).toEqual([]);
  });
});

function makeMockPiBinary(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-runtime-"));
  const agentPath = NodePath.join(directory, "agent.mjs");
  const binaryPath = NodePath.join(directory, "fake-pi.sh");
  NodeFS.writeFileSync(
    agentPath,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let buffer = "";
let selected = { provider: "custom", id: "starter", name: "Starter" };
let thinkingLevel = "high";
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sessionDirectory = argumentValue("--session-dir");
const sessionId = argumentValue("--session-id") ?? "thread-native";
const sessionFile = sessionDirectory ? join(sessionDirectory, \`\${sessionId}.jsonl\`) : "/tmp/thread-native.jsonl";

function respond(command, data) {
  process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) }) + "\\n");
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      respond(command, { sessionId, sessionFile, model: selected, thinkingLevel });
      return;
    case "get_available_models":
      respond(command, { models: [selected, { provider: "custom", id: "team/coder", name: "Team Coder" }] });
      return;
    case "set_model":
      selected = { provider: command.provider, id: command.modelId, name: command.modelId };
      respond(command, selected);
      return;
    case "get_available_thinking_levels":
      respond(command, { levels: ["off", "high", "max"] });
      return;
    case "set_thinking_level":
      thinkingLevel = command.level;
      respond(command);
      return;
    case "prompt":
      if (sessionDirectory) {
        mkdirSync(sessionDirectory, { recursive: true });
        writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, message: command.message }) + "\\n");
      }
      respond(command);
      return;
    case "abort":
      respond(command);
      return;
    default:
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Unknown command" }) + "\\n");
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
`,
    "utf8",
  );
  NodeFS.writeFileSync(
    binaryPath,
    `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

it.effect("starts Pi persistent mode with a stable native ID and drives model RPC", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const sessionDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-native-session-"),
    );
    const siblingInstanceDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-native-session-sibling-"),
    );
    const runtime = yield* makePiSessionRuntime({
      binaryPath,
      configDirectory: "/tmp/pi-config",
      launchArgs: "",
      cwd: process.cwd(),
      sessionDirectory,
      sessionId: "thread-native",
    });

    const started = yield* runtime.start();
    expect(started).toMatchObject({
      sessionId: "thread-native",
      sessionFile: NodePath.join(sessionDirectory, "thread-native.jsonl"),
      model: { provider: "custom", id: "starter" },
    });

    expect(yield* runtime.getAvailableModels()).toContainEqual({
      provider: "custom",
      id: "team/coder",
      name: "Team Coder",
    });
    yield* runtime.setModel({ provider: "custom", modelId: "team/coder" });
    expect(yield* runtime.getAvailableThinkingLevels()).toEqual(["off", "high", "max"]);
    yield* runtime.setThinkingLevel("max");
    yield* runtime.prompt({ message: "Persist the first native Pi turn" });
    const sessionFile = NodePath.join(sessionDirectory, "thread-native.jsonl");
    expect(NodeFS.existsSync(sessionFile)).toBe(true);
    expect(NodeFS.readFileSync(sessionFile, "utf8")).toContain("thread-native");
    expect(NodeFS.existsSync(NodePath.join(siblingInstanceDirectory, "thread-native.jsonl"))).toBe(
      false,
    );
    expect(yield* runtime.getState()).toMatchObject({
      model: { provider: "custom", id: "team/coder" },
      thinkingLevel: "max",
    });

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
    NodeFS.rmSync(sessionDirectory, { recursive: true, force: true });
    NodeFS.rmSync(siblingInstanceDirectory, { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
