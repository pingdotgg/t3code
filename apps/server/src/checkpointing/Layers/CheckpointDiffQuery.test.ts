import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly turnFiles?: ProjectionThreadCheckpointContext["checkpoints"][number]["turnFiles"];
  readonly checkpoints?: ProjectionThreadCheckpointContext["checkpoints"];
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: input.checkpoints ?? [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        agentTouchedPaths: [],
        turnFiles: input.turnFiles ?? [],
        transitionFiles: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("CheckpointDiffQueryLive", () => {
  it.each([
    {
      name: "no attribution at all",
      files: [{ path: "src/a.ts", kind: "modified", additions: 5, deletions: 1 }],
      agentTouchedPaths: [] as string[],
      turnFiles: [] as ReadonlyArray<{
        path: string;
        kind: string;
        additions: number;
        deletions: number;
      }>,
    },
    {
      name: "partial attribution",
      files: [
        { path: "src/a.ts", kind: "modified", additions: 5, deletions: 1 },
        { path: "src/b.ts", kind: "modified", additions: 9, deletions: 0 },
      ],
      agentTouchedPaths: ["src/a.ts"],
      turnFiles: [{ path: "src/a.ts", kind: "modified", additions: 5, deletions: 1 }],
    },
    {
      name: "a capped touched-path set",
      files: [{ path: "src/bulk.ts", kind: "modified", additions: 900, deletions: 4 }],
      agentTouchedPaths: Array.from({ length: 500 }, (_, index) => `src/bulk-${index}.ts`),
      turnFiles: [{ path: "src/bulk.ts", kind: "modified", additions: 900, deletions: 4 }],
    },
  ])(
    "never path-filters a turn diff when there is $name",
    async ({ files, agentTouchedPaths, turnFiles }) => {
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const calls: Array<ReadonlyArray<string> | undefined> = [];
      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: toCheckpointRef,
            status: "ready",
            files,
            agentTouchedPaths,
            turnFiles,
            transitionFiles: [],
            assistantMessageId: null,
            completedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const checkpointStore: CheckpointStoreShape = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        createWorkspaceSnapshotCommit: () =>
          Effect.die("CheckpointDiffQuery should not snapshot worktrees"),
        hasCheckpointRef: () =>
          Effect.die("CheckpointDiffQuery should not preflight checkpoint refs"),
        checkpointRefMatchesWorkspace: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ paths }) =>
          Effect.sync(() => {
            calls.push(paths);
            return "full range patch";
          }),
        diffCheckpointFiles: () => Effect.succeed([]),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQueryLive.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery, {
            getSnapshot: () => Effect.die("unused"),
            getShellSnapshot: () => Effect.die("unused"),
            getActiveChatArchiveEntries: () => Effect.die("unused"),
            getSnapshotSequence: () => Effect.die("unused"),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
            listThreadProjectIds: () => Effect.die("unused"),
            getThreadActivitiesPage: () => Effect.die("unused"),
            readThread: () => Effect.die("unused"),
          }),
        ),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
            scope: "turn",
          });
        }).pipe(Effect.provide(layer)),
      );

      expect(calls).toEqual([undefined]);
      expect(result.diff).toBe("full range patch");
    },
  );

  it("never path-filters a conversation diff, even when a turn's summary failed", async () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
    const calls: Array<ReadonlyArray<string> | undefined> = [];
    const modified = (path: string) => ({
      path,
      kind: "modified" as const,
      additions: 1,
      deletions: 0,
    });
    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      checkpointTurnCount: 2,
      checkpointRef: toCheckpointRef,
      checkpoints: [
        {
          turnId: TurnId.make("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          status: "ready",
          files: [modified("src/first.ts")],
          agentTouchedPaths: ["src/first.ts"],
          turnFiles: [modified("src/first.ts")],
          transitionFiles: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          turnId: TurnId.make("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: toCheckpointRef,
          status: "ready",
          files: [],
          agentTouchedPaths: [],
          turnFiles: [],
          transitionFiles: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      createWorkspaceSnapshotCommit: () => Effect.die("unused in checkpoint diff tests"),
      hasCheckpointRef: () => Effect.succeed(true),
      checkpointRefMatchesWorkspace: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ paths }) =>
        Effect.sync(() => {
          calls.push(paths);
          return "full conversation patch";
        }),
      diffCheckpointFiles: () => Effect.succeed([]),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getActiveChatArchiveEntries: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          listThreadProjectIds: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          readThread: () => Effect.die("unused"),
        }),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      }).pipe(Effect.provide(layer)),
    );

    expect(calls).toEqual([undefined]);
  });

  it("falls back to the project workspace when an archived worktree was removed", async () => {
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCwd: string[] = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: "/tmp/removed-worktree",
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: (cwd) => Effect.succeed(cwd === "/tmp/workspace"),
      captureCheckpoint: () => Effect.void,
      createWorkspaceSnapshotCommit: () => Effect.die("unused in checkpoint diff tests"),
      hasCheckpointRef: () =>
        Effect.die("CheckpointDiffQuery should not preflight checkpoint refs"),
      checkpointRefMatchesWorkspace: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ cwd }) =>
        Effect.sync(() => {
          diffCwd.push(cwd);
          return "diff patch";
        }),
      diffCheckpointFiles: () => Effect.succeed([]),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getActiveChatArchiveEntries: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          listThreadProjectIds: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          readThread: () => Effect.die("unused"),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          scope: "snapshot",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCwd).toEqual(["/tmp/workspace"]);
    expect(result.diff).toBe("diff patch");
  });

  it("rejects turn-scoped diffs when the requested range spans more than one checkpoint transition", async () => {
    const threadId = ThreadId.make("thread-1");
    let snapshotRequested = false;
    let diffCalled = false;
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      createWorkspaceSnapshotCommit: () => Effect.die("unused in checkpoint diff tests"),
      hasCheckpointRef: () => Effect.succeed(true),
      checkpointRefMatchesWorkspace: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () =>
        Effect.sync(() => {
          diffCalled = true;
          return "unexpected";
        }),
      diffCheckpointFiles: () => Effect.succeed([]),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getActiveChatArchiveEntries: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () =>
            Effect.sync(() => {
              snapshotRequested = true;
              return Option.none();
            }),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          listThreadProjectIds: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          readThread: () => Effect.die("unused"),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 2,
            scope: "turn",
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow(/single checkpoint transition/);

    expect(diffCalled).toBe(false);
    expect(snapshotRequested).toBe(false);
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.make("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      createWorkspaceSnapshotCommit: () => Effect.die("unused in checkpoint diff tests"),
      hasCheckpointRef: () => Effect.succeed(true),
      checkpointRefMatchesWorkspace: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      diffCheckpointFiles: () => Effect.succeed([]),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
          getShellSnapshot: () =>
            Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
          getActiveChatArchiveEntries: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadShellProjectContextById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
          listThreadProjectIds: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          readThread: () => Effect.die("unused"),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
            scope: "snapshot",
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});
