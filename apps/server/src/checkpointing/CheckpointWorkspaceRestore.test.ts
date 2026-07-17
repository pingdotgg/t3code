import { assert, it } from "@effect/vitest";
import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as CheckpointWorkspaceRestore from "./CheckpointWorkspaceRestore.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";

it.effect("restores workspace files without mutating thread history", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-1");
    const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/thread-1/turn/1");
    const restoreCheckpoint = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      Effect.succeed(true),
    );
    const captureCheckpoint = vi.fn(
      (_input: CheckpointStore.CaptureCheckpointInput) => Effect.void,
    );
    const refreshEntries = vi.fn((_cwd: string) => Effect.void);
    const refreshLocalStatus = vi.fn((_cwd: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
    );

    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadCheckpointContext: () =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId: ProjectId.make("project-1"),
              workspaceRoot: "/workspace",
              worktreePath: "/workspace/worktree",
              checkpoints: [
                {
                  turnId: TurnId.make("turn-1"),
                  checkpointTurnCount: 1,
                  checkpointRef,
                  status: "ready",
                  files: [],
                  assistantMessageId: null,
                  completedAt: "2026-07-17T00:00:00.000Z",
                },
              ],
            }),
          ),
      }),
      Layer.mock(CheckpointStore.CheckpointStore)({ restoreCheckpoint, captureCheckpoint }),
      Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: refreshEntries }),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({
            absolutePath: `${workspaceRoot}/${relativePath}`,
            relativePath,
          }),
      }),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({ refreshLocalStatus }),
    );
    const result = yield* CheckpointWorkspaceRestore.restoreWorkspaceCheckpoint({
      threadId,
      turnCount: 1,
      filePaths: ["README.md"],
    }).pipe(Effect.provide(dependencies));

    assert.deepStrictEqual(result, { restored: true });
    assert.deepStrictEqual(restoreCheckpoint.mock.calls[0]?.[0], {
      cwd: "/workspace/worktree",
      checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      fallbackToHead: true,
      filePaths: ["README.md"],
    });
    assert.deepStrictEqual(captureCheckpoint.mock.calls[0]?.[0], {
      cwd: "/workspace/worktree",
      checkpointRef,
    });
    assert.deepStrictEqual(refreshEntries.mock.calls[0]?.[0], "/workspace/worktree");
    assert.deepStrictEqual(refreshLocalStatus.mock.calls[0]?.[0], "/workspace/worktree");
  }),
);

it.effect("rejects restores for non-latest turns", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-1");
    const olderRef = CheckpointRef.make("refs/t3/checkpoints/thread-1/turn/1");
    const latestRef = CheckpointRef.make("refs/t3/checkpoints/thread-1/turn/2");
    const restoreCheckpoint = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      Effect.succeed(true),
    );

    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getThreadCheckpointContext: () =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId: ProjectId.make("project-1"),
              workspaceRoot: "/workspace",
              worktreePath: "/workspace/worktree",
              checkpoints: [
                {
                  turnId: TurnId.make("turn-1"),
                  checkpointTurnCount: 1,
                  checkpointRef: olderRef,
                  status: "ready",
                  files: [],
                  assistantMessageId: null,
                  completedAt: "2026-07-17T00:00:00.000Z",
                },
                {
                  turnId: TurnId.make("turn-2"),
                  checkpointTurnCount: 2,
                  checkpointRef: latestRef,
                  status: "ready",
                  files: [],
                  assistantMessageId: null,
                  completedAt: "2026-07-17T00:01:00.000Z",
                },
              ],
            }),
          ),
      }),
      Layer.mock(CheckpointStore.CheckpointStore)({ restoreCheckpoint }),
      Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({
            absolutePath: `${workspaceRoot}/${relativePath}`,
            relativePath,
          }),
      }),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
        refreshLocalStatus: () =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
      }),
    );

    const error = yield* CheckpointWorkspaceRestore.restoreWorkspaceCheckpoint({
      threadId,
      turnCount: 1,
    }).pipe(Effect.provide(dependencies), Effect.flip);

    assert.strictEqual(error._tag, "CheckpointWorkspaceRestoreFailedError");
    if (error._tag === "CheckpointWorkspaceRestoreFailedError") {
      assert.strictEqual(error.detail, "Only the latest workspace checkpoint can be rewound.");
    }
    assert.strictEqual(restoreCheckpoint.mock.calls.length, 0);
  }),
);
