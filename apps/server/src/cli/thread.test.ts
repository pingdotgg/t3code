import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { type ThreadTools, launchModelSelection, waitForRun } from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

it.effect("start sends each --option as a typed model option", () =>
  Effect.gen(function* () {
    const selection = yield* launchModelSelection({
      provider: Option.some("codex"),
      model: Option.some("gpt-6.1-sol"),
      option: ["reasoningEffort=high", " fastMode = false ", "note=a=b"],
    });

    assert.deepStrictEqual(selection, {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
        { id: "note", value: "a=b" },
      ],
    });
  }),
);

it.effect("start rejects a repeated --option before reaching the server", () =>
  Effect.gen(function* () {
    const error = yield* runCli([
      "thread",
      "start",
      ".",
      "hi",
      "--provider",
      "codex",
      "--model",
      "gpt-6.1-sol",
      "--option",
      "reasoningEffort=high",
      "--option",
      "reasoningEffort=low",
    ]).pipe(Effect.flip);

    assert.strictEqual(error.message, "--option reasoningEffort is given more than once.");
  }),
);

it.effect("start rejects --option without an explicit model", () =>
  Effect.gen(function* () {
    const error = yield* runCli(["thread", "start", ".", "hi", "--option", "effort=high"]).pipe(
      Effect.flip,
    );

    assert.strictEqual(error.message, "--option needs --provider and --model.");
  }),
);
