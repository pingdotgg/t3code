import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ThreadTools, waitForRun } from "./thread.ts";

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
        {
          threadId,
          runId,
          status: "running",
          timedOut: true,
          hasPendingQuestion: false,
          pendingApproval: null,
        },
        {
          threadId,
          runId: continuation,
          status: "failed",
          timedOut: false,
          hasPendingQuestion: false,
          pendingApproval: null,
        },
      ],
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
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        {
          threadId,
          runId,
          status: "queued",
          timedOut: false,
          hasPendingQuestion: true,
          pendingApproval: null,
        },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
    assert.deepStrictEqual(
      calls.map((call) => call.tool),
      ["t3_thread_wait"],
    );
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        {
          threadId,
          runId,
          status: "running",
          timedOut: true,
          hasPendingQuestion: false,
          pendingApproval: null,
        },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          hasPendingQuestion: false,
          pendingApproval: null,
        },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);
