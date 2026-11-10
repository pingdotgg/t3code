import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";

it.effect.each([false, true])(
  "reconciles shared worktree branches without changing root checkouts or detached HEADs, conflict=%s",
  (conflict) => {
    const reconciled = Deferred.makeUnsafe<void>();
    const commands: OrchestrationV2ServerCommand[] = [];
    const thread = (id: string, branch: string, worktreePath: string | null) =>
      ({ id: ThreadId.make(id), branch, worktreePath }) as OrchestrationV2ThreadShell;
    const snapshot = {
      schemaVersion: 2,
      snapshotSequence: 0,
      threads: [
        thread("generated", "t3/unify-converter-branches", "/worktree"),
        thread("shared", "t3/bfc349ae", "/link/worktree"),
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
          ["shared", "union", "t3/bfc349ae", "/link/worktree"],
          ["archived", "union", "t3/bfc349ae", "/worktree"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            realPath: (path) => Effect.succeed(path === "/link/worktree" ? "/worktree" : path),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadWorktreePaths: () =>
              Effect.succeed(
                [...snapshot.threads, ...snapshot.archivedThreads].flatMap((thread) =>
                  thread.worktreePath === null
                    ? []
                    : [{ threadId: thread.id, worktreePath: thread.worktreePath }],
                ),
              ),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            streamBranchChanges: Stream.fromIterable([null, "t3/bfc349ae", "union"]).pipe(
              Stream.map((refName) => ({
                cwd: "/worktree",
                refName,
              })),
              Stream.ensuring(Deferred.succeed(reconciled, undefined)),
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
                  command.threadId === ThreadId.make("generated") &&
                  conflict
                ) {
                  return yield* new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "Thread moved before branch metadata could be applied.",
                  });
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
