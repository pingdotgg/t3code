import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  PiRpcCommandError,
  type PiRpcClient,
  type PiRpcSpawnOptions,
} from "../provider/pi/PiRpcClient.ts";
import type { PiRpcEvent, PiThinkingLevel } from "../provider/pi/PiRpcSchema.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const assert: typeof NodeAssert = NodeAssert;
const isTextGenerationError = Schema.is(TextGenerationError);

class FakeClient implements PiRpcClient {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The synchronous fake exposes its queue through the PiRpcClient stream interface.
  readonly queue = Effect.runSync(Queue.unbounded<PiRpcEvent>());
  readonly events = Stream.fromQueue(this.queue);
  readonly models: Array<[string, string]> = [];
  readonly thinking: PiThinkingLevel[] = [];
  closeCalls = 0;
  failPrompt = false;
  settle = true;
  shutdownAfterPrompt = false;
  promptEvents: PiRpcEvent[] | undefined;
  output = '{"subject":"Ship Pi generation","body":"Use RPC output."}';
  getState = () => Effect.succeed({});
  getAvailableModels = () => Effect.succeed({ models: [] });
  getCommands = () => Effect.succeed({ commands: [] });
  getSessionStats = () =>
    Effect.succeed({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  setModel = (provider: string, modelId: string) =>
    Effect.sync(() => {
      this.models.push([provider, modelId]);
      return { provider, id: modelId };
    });
  setThinkingLevel = (level: PiThinkingLevel) =>
    Effect.sync(() => {
      this.thinking.push(level);
    });
  prompt = () => {
    // oxlint-disable-next-line typescript/no-this-alias -- Effect.gen generator callbacks do not preserve lexical this.
    const self = this;
    return self.failPrompt
      ? Effect.fail(
          new PiRpcCommandError({ command: "prompt", requestId: "test", detail: "prompt failed" }),
        )
      : Effect.gen(function* () {
          yield* Queue.offerAll(
            self.queue,
            self.promptEvents ?? [
              {
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: `preface ${self.output}` },
              },
              {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: self.output }] },
              },
              ...(self.settle ? [{ type: "agent_settled" }] : []),
            ],
          );
          if (self.shutdownAfterPrompt) yield* Queue.shutdown(self.queue);
        });
  };
  abort = () => Effect.void;
  respondToExtensionUi = () => Effect.void;
  close = () =>
    Effect.sync(() => {
      this.closeCalls += 1;
    });
}

const settings = Schema.decodeSync(PiSettings)({ binaryPath: "fake-pi" });
const selection = createModelSelection(ProviderInstanceId.make("pi-test"), "openai%20api/gpt%2F5", [
  { id: "thinkingLevel", value: "high" },
]);
const input = {
  cwd: "/tmp/pi-generation",
  branch: "feature/pi",
  stagedSummary: "M pi.ts",
  stagedPatch: "diff --git a/pi.ts b/pi.ts",
  modelSelection: selection,
};

const makeHarness = (client: FakeClient, spawns: PiRpcSpawnOptions[], timeoutMs?: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const textGeneration = yield* makePiTextGeneration(
        settings,
        { PI_TOKEN: "test" },
        (options) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              spawns.push(options);
              return client;
            }),
            (opened) => opened.close(),
          ),
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      return yield* textGeneration.generateCommitMessage(input);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("selects the decoded model and thinking level, then parses assistant text", () => {
  const client = new FakeClient();
  const spawns: PiRpcSpawnOptions[] = [];
  return Effect.gen(function* () {
    const result = yield* makeHarness(client, spawns);

    assert.deepEqual(result, { subject: "Ship Pi generation", body: "Use RPC output." });
    assert.deepEqual(client.models, [["openai api", "gpt/5"]]);
    assert.deepEqual(client.thinking, ["high"]);
    assert.equal(spawns[0]?.cwd, input.cwd);
    assert.equal(spawns[0]?.env?.PI_TOKEN, "test");
    assert.equal(spawns[0]?.args?.includes("--no-session"), true);
    for (const arg of [
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ])
      assert.equal(spawns[0]?.args?.includes(arg), false);
    assert.equal(client.closeCalls, 1);
  });
});

it.effect("closes the RPC client when generation fails", () => {
  const client = new FakeClient();
  client.failPrompt = true;
  return Effect.gen(function* () {
    const result = yield* makeHarness(client, []).pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(isTextGenerationError(result.failure), true);
    assert.equal(client.closeCalls, 1);
  });
});

it.effect("uses only the last completed assistant message across attempts", () => {
  const client = new FakeClient();
  client.promptEvents = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"subject":"Stale","body":"old"}' }],
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"subject":"Final","body":"correct"}' }],
      },
    },
    { type: "agent_settled" },
  ];
  return Effect.gen(function* () {
    const result = yield* makeHarness(client, []);
    assert.deepEqual(result, { subject: "Final", body: "correct" });
  });
});

it.effect("preserves structured Pi protocol failures without exposing raw output", () => {
  const client = new FakeClient();
  const protocolFailure = {
    _tag: "PiRpcProtocolFailureEvent" as const,
    reason: "MalformedJson" as const,
    line: '{"private":"output"',
    detail: "JSON parse failed near private output",
  };
  client.promptEvents = [protocolFailure];
  return Effect.gen(function* () {
    const result = yield* makeHarness(client, []).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.detail, "Pi RPC protocol failed before generation settled.");
      assert.deepEqual(result.failure.cause, protocolFailure);
      assert.equal(result.failure.message.includes(protocolFailure.detail), false);
    }
    assert.equal(client.closeCalls, 1);
  });
});

it.effect("fails and closes when the event stream ends before agent settlement", () => {
  const client = new FakeClient();
  client.settle = false;
  client.shutdownAfterPrompt = true;
  return Effect.gen(function* () {
    const result = yield* makeHarness(client, []).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(isTextGenerationError(result.failure), true);
      assert.match(result.failure.detail, /stream ended/);
    }
    assert.equal(client.closeCalls, 1);
  });
});

it.effect("fails and closes once after the overall timeout", () => {
  const client = new FakeClient();
  client.settle = false;
  client.promptEvents = [];
  return Effect.gen(function* () {
    const fiber = yield* makeHarness(client, [], 1_000).pipe(Effect.result, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.match(result.failure.detail, /timed out/);
    assert.equal(client.closeCalls, 1);
  });
});

it.effect("rejects an aborted final assistant message", () => {
  const client = new FakeClient();
  client.promptEvents = [
    {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    },
  ];
  return Effect.gen(function* () {
    const result = yield* makeHarness(client, []).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.match(result.failure.detail, /aborted/);
    assert.equal(client.closeCalls, 1);
  });
});
