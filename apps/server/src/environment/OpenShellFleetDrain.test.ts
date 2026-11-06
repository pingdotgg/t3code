import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "@t3tools/contracts";

import {
  type DrainDependencies,
  FleetDrainStepError,
  makeDrainExecutor,
} from "./OpenShellFleetDrain.ts";

const environmentId = EnvironmentId.make("environment:worker");

const deps = (input: {
  readonly threads: ReadonlyArray<string>;
  readonly projects?: ReadonlyArray<string>;
  readonly now?: number;
  readonly failThread?: string;
  readonly pushExitCode?: number;
  readonly liveThread?: string;
  readonly sequences?: Readonly<Record<string, number>>;
  readonly seeded?: ReadonlyArray<{
    readonly drainId: string;
    readonly threadId: string;
    readonly snapshotSequence: number | null;
  }>;
}): DrainDependencies & {
  readonly written: Array<{ drainId: string; threadId: string; body: string }>;
  readonly fetched: Array<string>;
  readonly pushed: Array<string>;
} => {
  const files = new Map<string, string>(
    (input.seeded ?? []).map((entry) => [
      `${entry.drainId}/${entry.threadId}`,
      JSON.stringify({
        threadId: entry.threadId,
        snapshotSequence: entry.snapshotSequence,
        body: `{"threadId":"${entry.threadId}","seeded":true}`,
      }),
    ]),
  );
  const written: Array<{ drainId: string; threadId: string; body: string }> = [];
  const fetched: Array<string> = [];
  const pushed: Array<string> = [];
  return {
    written,
    fetched,
    pushed,
    now: Effect.succeed(input.now ?? 0),
    source: {
      shell: () =>
        Effect.succeed({
          threads: input.threads.map((threadId) => ({
            threadId,
            live: input.liveThread === threadId,
          })),
          projects: (input.projects ?? []).map((workspaceRoot) => ({ workspaceRoot })),
        }),
      threadSequence: ({ threadId }) =>
        Effect.succeed({ snapshotSequence: input.sequences?.[threadId] ?? 1 }),
      threadHistory: ({ threadId }) => {
        fetched.push(threadId);
        return threadId === input.failThread
          ? Effect.fail(
              new FleetDrainStepError({ step: "history", message: "the worker went away" }),
            )
          : Effect.succeed({
              body: `{"threadId":"${threadId}","events":[1,2,3]}`,
              snapshotSequence: input.sequences?.[threadId] ?? 1,
            });
      },
    },
    sink: {
      write: ({ drainId, threadId, body }) =>
        Effect.sync(() => {
          files.set(`${drainId}/${threadId}`, body);
          written.push({ drainId, threadId, body });
          return { bytes: body.length };
        }),
      read: ({ drainId, threadId }) =>
        Effect.gen(function* () {
          const raw = files.get(`${drainId}/${threadId}`);
          if (raw === undefined) return null;
          const parsed = JSON.parse(raw) as { threadId: string; snapshotSequence?: number };
          return {
            threadId: parsed.threadId,
            snapshotSequence:
              typeof parsed.snapshotSequence === "number" ? parsed.snapshotSequence : null,
            body: raw,
          };
        }),
    },
    git: {
      push: ({ workspaceRoot }) =>
        Effect.sync(() => {
          pushed.push(workspaceRoot);
          return { exitCode: input.pushExitCode ?? 0, stderr: "" };
        }),
    },
  };
};

const drain = (
  dependencies: DrainDependencies,
  overrides: Partial<{ drainId: string; deadlineAt: number; snapshotOnly: boolean }> = {},
) =>
  makeDrainExecutor(dependencies).drain({
    environmentId,
    sandboxName: "sandbox-1",
    drainId: overrides.drainId ?? "drain:environment:worker:1",
    snapshotOnly: overrides.snapshotOnly ?? false,
    deadlineAt: overrides.deadlineAt ?? Number.MAX_SAFE_INTEGER,
  });

describe("fleet drain", () => {
  it.effect("acks threads and checkout pushes only when each one landed", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], projects: ["/work/a"] });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("acked");
      expect(outcome.threads).toEqual({ total: 2, acked: 2, failed: 0 });
      expect(outcome.worktrees).toEqual({ total: 1, acked: 1, failed: 0 });
      expect(dependencies.pushed).toEqual(["/work/a"]);
    }),
  );

  it.effect("does not re-fetch a thread whose previous copy is still current", () =>
    Effect.gen(function* () {
      const first = deps({ threads: ["thread:a", "thread:b"], failThread: "thread:b" });
      yield* drain(first, { drainId: "drain:environment:worker:1" });
      const retry = deps({
        threads: ["thread:a", "thread:b"],
        seeded: first.written.map((entry) => ({
          drainId: "drain:environment:worker:1",
          threadId: entry.threadId,
          snapshotSequence: 1,
        })),
      });
      const outcome = yield* drain(retry, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      // thread:a is still current, so only the failed thread is fetched again.
      expect(retry.fetched).toEqual(["thread:b"]);
      expect(retry.written.map((entry) => entry.threadId)).toEqual(["thread:b"]);
    }),
  );

  it.effect("re-copies a thread whose worker state changed since the failed drain", () =>
    Effect.gen(function* () {
      const first = deps({ threads: ["thread:a", "thread:b"], failThread: "thread:b" });
      yield* drain(first, { drainId: "drain:environment:worker:1" });
      const retry = deps({
        threads: ["thread:a", "thread:b"],
        sequences: { "thread:a": 2 },
        seeded: first.written.map((entry) => ({
          drainId: "drain:environment:worker:1",
          threadId: entry.threadId,
          snapshotSequence: 1,
        })),
      });
      const outcome = yield* drain(retry, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      expect(outcome.threads).toEqual({ total: 2, acked: 2, failed: 0 });
      // The changed thread is fetched and written again under the new generation.
      expect(retry.fetched).toEqual(["thread:a", "thread:b"]);
      expect(retry.written.map((entry) => entry.threadId)).toEqual(["thread:a", "thread:b"]);
    }),
  );

  it.effect("never trusts copies left under its own drain id or with a stale marker", () =>
    Effect.gen(function* () {
      // A timed-out run leaves a stale copy under the previous generation and a
      // fresh-looking one under the id this retry runs under; neither may count.
      const dependencies = deps({
        threads: ["thread:a"],
        sequences: { "thread:a": 7 },
        seeded: [
          {
            drainId: "drain:environment:worker:1",
            threadId: "thread:a",
            snapshotSequence: 3,
          },
          {
            drainId: "drain:environment:worker:2",
            threadId: "thread:a",
            snapshotSequence: 7,
          },
        ],
      });
      const outcome = yield* drain(dependencies, { drainId: "drain:environment:worker:2" });

      expect(outcome.state).toBe("acked");
      expect(dependencies.fetched).toEqual(["thread:a"]);
      expect(dependencies.written.map((entry) => entry.drainId)).toEqual([
        "drain:environment:worker:2",
      ]);
    }),
  );

  it.effect("keeps the sandbox when a thread cannot be copied", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], failThread: "thread:b" });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.threads).toEqual({ total: 2, acked: 1, failed: 1 });
    }),
  );

  it.effect("refuses to drain a worker whose child is still working", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a"], liveThread: "thread:a" });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.finishedAt).toBeNull();
      expect(outcome.threads.failed).toBe(1);
      expect(dependencies.written).toHaveLength(0);
    }),
  );

  it.effect("keeps the sandbox when a checkout was not pushed", () =>
    Effect.gen(function* () {
      const dependencies = deps({
        threads: ["thread:a"],
        projects: ["/work/a"],
        pushExitCode: 1,
      });
      const outcome = yield* drain(dependencies);

      expect(outcome.state).toBe("failed");
      expect(outcome.worktrees).toEqual({ total: 1, acked: 0, failed: 1 });
    }),
  );

  it.effect("stops at the deadline instead of claiming a partial drain", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], now: 5_000 });
      const outcome = yield* drain(dependencies, { deadlineAt: 1_000 });

      expect(outcome.state).toBe("failed");
      expect(outcome.threads).toEqual({ total: 0, acked: 0, failed: 0 });
      expect(dependencies.written).toHaveLength(0);
    }),
  );

  it.effect("copies threads but skips pushes for a forced removal", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a"], projects: ["/work/a"] });
      const outcome = yield* drain(dependencies, { snapshotOnly: true });

      expect(outcome.state).toBe("acked");
      expect(outcome.threads.acked).toBe(1);
      expect(dependencies.pushed).toHaveLength(0);
    }),
  );
});
