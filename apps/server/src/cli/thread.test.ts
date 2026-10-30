// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
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

it.layer(NodeServices.layer)("thread CLI state", (it) => {
  it.effect.each(["registered", "not registered"] as const)(
    "does not create a database when a server is %s and statev2.sqlite is missing",
    (server) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-cli-missing-db-" });
        const baseDir = NodePath.join(root, "state");
        if (server === "registered") {
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port: 1,
            }),
          });
        }

        const result = yield* Command.runWith(cli, { version: "0.0.0" })([
          "thread",
          "list",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
          Effect.result,
        );

        assert.isFalse(
          yield* fs.exists(NodePath.join(baseDir, "userdata", "statev2.sqlite")),
          "t3 thread must not create statev2.sqlite",
        );
        assert.equal(result._tag, "Failure");
      }),
  );
});
