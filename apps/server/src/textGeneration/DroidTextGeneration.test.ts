// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DroidSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeDroidTextGeneration } from "./DroidTextGeneration.ts";

import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeSync(DroidSettings);
const readParams = <A>(path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8")) as A;

function makeTextGenerationDroid(options: {
  readonly structuredOutput?: Record<string, unknown> | null;
  readonly assistantText?: string;
  readonly completionReason: string;
}) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-droid-text-"));
  const scriptPath = NodePath.join(tempDir, "fake-droid.mjs");
  const binaryPath = NodePath.join(tempDir, "droid");
  const initializeParamsPath = NodePath.join(tempDir, "initialize-params.json");
  const addUserMessageParamsPath = NodePath.join(tempDir, "add-user-message-params.json");
  NodeFS.writeFileSync(
    scriptPath,
    `
import * as fs from "node:fs";
import * as readline from "node:readline";
const write = (message) => console.log(JSON.stringify({
  jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.187.0", ...message
}));
const respond = (id, result) => write({ type: "response", id, result });
const notify = (notification) => write({ type: "notification",
  method: "droid.session_notification", params: { sessionId: "text-session", notification } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "droid.initialize_session") {
    fs.writeFileSync(${JSON.stringify(initializeParamsPath)}, JSON.stringify(request.params));
    respond(request.id, { sessionId: "text-session" });
  } else if (request.method === "droid.add_user_message") {
    fs.writeFileSync(${JSON.stringify(addUserMessageParamsPath)}, JSON.stringify(request.params));
    if (typeof request.params?.messageId !== "string" || !request.params.messageId) {
      write({ type: "response", id: request.id, error:
        { code: -32602, message: "add_user_message requires messageId" }});
      continue;
    }
    respond(request.id, {});
    const assistantText = ${JSON.stringify(options.assistantText)};
    if (assistantText !== undefined) notify({ type: "assistant_text_delta",
      messageId: "assistant-1", blockIndex: 0, textDelta: assistantText });
    const structuredOutput = ${JSON.stringify(options.structuredOutput)};
    if (structuredOutput !== undefined) notify({ type: "structured_output",
      messageId: "assistant-1", structuredOutput });
    notify({
      type: "agent_turn_completed", reason: ${JSON.stringify(options.completionReason)},
      turnId: "turn-1", tokenUsage: { inputTokens: 1, outputTokens: 1,
        cacheCreationTokens: 0, cacheReadTokens: 0, thinkingTokens: 0 }
    });
  }
}
`,
  );
  NodeFS.writeFileSync(
    binaryPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}\n`,
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return { addUserMessageParamsPath, binaryPath, initializeParamsPath, tempDir };
}

const generate = (options: Parameters<typeof makeTextGenerationDroid>[0]) =>
  Effect.gen(function* () {
    const fixture = makeTextGenerationDroid(options);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(fixture.tempDir, { recursive: true, force: true })),
    );
    const textGeneration = yield* makeDroidTextGeneration(
      decodeSettings({ binaryPath: fixture.binaryPath }),
    );
    const result = yield* Effect.result(
      textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Generate a concise title",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "mock-fast"),
      }),
    );
    return {
      result,
      initialize: readParams<{
        restrictToolIds?: ReadonlyArray<string>;
        blockOnMcpLoad?: boolean;
      }>(fixture.initializeParamsPath),
      addMessage: readParams<{
        outputFormat?: { type: string; schema: Record<string, unknown> };
      }>(fixture.addUserMessageParamsPath),
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), TestClock.withLive);

it.effect("fails observably when native structured output exceeds the one-shot limit", () =>
  Effect.gen(function* () {
    const { addMessage, initialize, result } = yield* generate({
      structuredOutput: { title: " ".repeat(300_000) },
      completionReason: "completed",
    });
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure._tag, "TextGenerationError");
      assert.include(result.failure.detail, "output exceeded the 262144-byte limit");
    }
    assert.deepStrictEqual(initialize.restrictToolIds, ["t3_text_generation"]);
    assert.equal(initialize.blockOnMcpLoad, false);
    assert.equal(addMessage.outputFormat?.type, "json_schema");
    assert.equal(addMessage.outputFormat?.schema.type, "object");
  }),
);

it.effect("decodes native structured output instead of assistant text JSON", () =>
  Effect.gen(function* () {
    const { result } = yield* generate({
      structuredOutput: { title: "Native structured title" },
      assistantText: "not json",
      completionReason: "completed",
    });
    assert.equal(result._tag, "Success");
    if (result._tag === "Success") {
      assert.deepStrictEqual(result.success, { title: "Native structured title" });
    }
  }),
);

it.effect("rejects structured output from an unsuccessful turn", () =>
  Effect.gen(function* () {
    const { result } = yield* generate({
      structuredOutput: { title: "Must not be accepted" },
      completionReason: "model_authentication_failed",
    });
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure._tag, "TextGenerationError");
      assert.include(result.failure.detail, "model_authentication_failed");
    }
  }),
);
