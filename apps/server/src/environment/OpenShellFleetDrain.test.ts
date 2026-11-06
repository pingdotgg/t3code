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
  readonly existing?: ReadonlyArray<string>;
}): DrainDependencies & {
  readonly written: Array<{ threadId: string; body: string }>;
  readonly pushed: Array<string>;
} => {
  const files = new Map<string, string>(
    (input.existing ?? []).map((threadId) => [threadId, '{"already":true}']),
  );
  const written: Array<{ threadId: string; body: string }> = [];
  const pushed: Array<string> = [];
  return {
    written,
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
      threadHistory: ({ threadId }) =>
        threadId === input.failThread
          ? Effect.fail(
              new FleetDrainStepError({ step: "history", message: "the worker went away" }),
            )
          : Effect.succeed({ body: `{"threadId":"${threadId}","events":[1,2,3]}` }),
    },
    sink: {
      write: ({ threadId, body }) =>
        Effect.sync(() => {
          files.set(threadId, body);
          written.push({ threadId, body });
          return { bytes: body.length };
        }),
      read: ({ threadId }) => Effect.succeed(files.get(threadId) ?? null),
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
  overrides: Partial<{ deadlineAt: number; snapshotOnly: boolean }> = {},
) =>
  makeDrainExecutor(dependencies).drain({
    environmentId,
    sandboxName: "sandbox-1",
    drainId: "drain:environment:worker:1",
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

  it.effect("re-reads what already landed instead of fetching it again", () =>
    Effect.gen(function* () {
      const dependencies = deps({ threads: ["thread:a", "thread:b"], existing: ["thread:a"] });
      const outcome = yield* drain(dependencies);

      expect(outcome.threads).toEqual({ total: 2, acked: 2, failed: 0 });
      // The thread that was already here is not copied twice.
      expect(dependencies.written.map((entry) => entry.threadId)).toEqual(["thread:b"]);
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
