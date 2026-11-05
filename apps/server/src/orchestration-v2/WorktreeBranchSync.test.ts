import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";

it.effect(
  "reconciles shared worktree branches without changing root checkouts or detached HEADs",
  () => {
    const reconciled = Deferred.makeUnsafe<void>();
    const commands: OrchestrationV2ServerCommand[] = [];
    const thread = (id: string, branch: string, worktreePath: string | null) =>
      ({ id: ThreadId.make(id), branch, worktreePath }) as OrchestrationV2ThreadShell;
    const snapshot = {
      schemaVersion: 2,
      snapshotSequence: 0,
      threads: [
        thread("generated", "t3/unify-converter-branches", "/worktree"),
        thread("shared", "t3/bfc349ae", "/worktree"),
        thread("current", "union", "/worktree"),
        thread("root", "main", null),
        thread("other", "feature", "/other"),
      ],
      archivedThreads: [thread("archived", "t3/bfc349ae", "/worktree")],
    };
    return Effect.gen(function* () {
      yield* Layer.build(WorktreeBranchSync.layer);
      yield* Deferred.await(reconciled);
      assert.deepEqual(
        commands.map((command) => {
          assert.equal(command.type, "thread.metadata.update");
          if (command.type !== "thread.metadata.update") throw new Error("Unexpected command");
          return [
            command.threadId,
            command.branch,
            command.expectedBranch,
            command.expectedWorktreePath,
          ];
        }),
        [
          ["generated", "union", "t3/unify-converter-branches", "/worktree"],
          ["shared", "union", "t3/bfc349ae", "/worktree"],
          ["archived", "union", "t3/bfc349ae", "/worktree"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            streamLocalChanges: Stream.fromIterable([null, "t3/bfc349ae", "union"]).pipe(
              Stream.map((refName) => ({
                cwd: "/worktree",
                local: {
                  isRepo: true,
                  refName,
                  isDefaultRef: false,
                  hasPrimaryRemote: false,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                },
              })),
            ),
          }),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            currentBranch: () => Effect.succeed("union"),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () => Effect.succeed(snapshot),
            dispatch: (command) =>
              Effect.gen(function* () {
                commands.push(command);
                if (
                  command.type === "thread.metadata.update" &&
                  command.threadId === ThreadId.make("archived")
                ) {
                  yield* Deferred.succeed(reconciled, undefined);
                }
                return { sequence: commands.length, storedEvents: [] };
              }),
          }),
        ),
      ),
      Effect.scoped,
    );
  },
);
