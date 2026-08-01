import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  findCanonicalActiveWorktreeOwner,
  logCleanupCauseUnlessInterrupted,
  processAfterWorktreeReservation,
  runAfterThreadRuntimeTeardown,
} from "./ThreadDeletionReactor.ts";

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    workflowRuns: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function makeThread(
  id: string,
  worktreePath: string | null,
  deletedAt: string | null = null,
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: "approval-required",
    pendingRuntimeMode: null,
    interactionMode: "default",
    branch: null,
    worktreePath,
    reviewResult: null,
    latestTurn: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    archivedAt: null,
    deletedAt,
    messages: [],
    proposedPlans: [],
    queuedTurns: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  describe("processAfterWorktreeReservation", () => {
    it("releases the ownership lock before slow cleanup work", async () => {
      let lockHeld = false;

      await Effect.runPromise(
        processAfterWorktreeReservation(
          (effect) =>
            Effect.sync(() => {
              lockHeld = true;
            }).pipe(
              Effect.andThen(effect),
              Effect.ensuring(
                Effect.sync(() => {
                  lockHeld = false;
                }),
              ),
            ),
          Effect.succeed(Option.some("reserved")),
          () =>
            Effect.sync(() => {
              expect(lockHeld).toBe(false);
            }),
        ),
      );
    });
  });

  describe("runAfterThreadRuntimeTeardown", () => {
    it("runs cleanup only after both teardown operations settle successfully", async () => {
      const events: string[] = [];

      await Effect.runPromise(
        runAfterThreadRuntimeTeardown(
          Effect.sync(() => {
            events.push("provider");
          }),
          Effect.sync(() => {
            events.push("terminal");
          }),
          Effect.sync(() => {
            events.push("cleanup");
          }),
        ),
      );

      expect(events.slice(0, 2).toSorted()).toEqual(["provider", "terminal"]);
      expect(events.at(-1)).toBe("cleanup");
    });

    it("does not run cleanup when teardown fails but still settles the other teardown", async () => {
      let terminalClosed = false;
      let cleanupRan = false;

      const exit = await Effect.runPromiseExit(
        runAfterThreadRuntimeTeardown(
          Effect.fail("provider stop failed"),
          Effect.sync(() => {
            terminalClosed = true;
          }),
          Effect.sync(() => {
            cleanupRan = true;
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminalClosed).toBe(true);
      expect(cleanupRan).toBe(false);
    });
  });

  describe("findCanonicalActiveWorktreeOwner", () => {
    const deletedThreadId = ThreadId.make("thread-deleted");
    const worktreePath = "/tmp/worktree";

    it("detects another active thread using a canonical path alias", async () => {
      const readModel = makeReadModel([
        makeThread("thread-deleted", worktreePath, "2026-07-30T00:00:01.000Z"),
        makeThread("thread-active", "/tmp/parent/../worktree"),
      ]);

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(readModel, deletedThreadId, worktreePath),
        ),
      ).resolves.toEqual(Option.some(ThreadId.make("thread-active")));
    });

    it("ignores deleted threads and different worktrees", async () => {
      const readModel = makeReadModel([
        makeThread("thread-deleted", worktreePath, "2026-07-30T00:00:01.000Z"),
        makeThread("thread-old", worktreePath, "2026-07-30T00:00:02.000Z"),
        makeThread("thread-other", "/tmp/other"),
      ]);

      await expect(
        Effect.runPromise(
          findCanonicalActiveWorktreeOwner(readModel, deletedThreadId, worktreePath),
        ),
      ).resolves.toEqual(Option.none());
    });
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
