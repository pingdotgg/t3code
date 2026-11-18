import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";
import * as WorktreeBranches from "./WorktreeBranches.ts";

it.effect.each(["safe", "conflict", "default", "held", "replaced", "busy", "unborn"] as const)(
  "reconciles shared worktree branches safely for %s",
  (scenario) => {
    const writable = scenario === "safe" || scenario === "conflict";
    const branch = scenario === "default" ? "main" : "union";
    const reconciled = Deferred.makeUnsafe<void>();
    const commands: OrchestrationV2ServerCommand[] = [];
    const thread = (id: string, branch: string, worktreePath: string | null) =>
      ({
        id: ThreadId.make(id),
        projectId: ProjectId.make("project"),
        branch,
        worktreePath,
        activeRunId: scenario === "busy" && id === "shared" ? RunId.make("running") : null,
        archivedAt: id === "archived" ? DateTime.makeUnsafe(3) : null,
        createdAt: DateTime.makeUnsafe(id === "generated" ? 0 : id === "shared" ? 1 : 2),
      }) as OrchestrationV2ThreadShell;
    const snapshot = {
      schemaVersion: 2,
      snapshotSequence: 0,
      threads: [
        thread("generated", "t3/unify-converter-branches", "/worktree"),
        thread("shared", "t3/bfc349ae", "/link/worktree"),
        thread("current", branch, "/worktree"),
        thread("root", "main", null),
        thread("other", "feature", "/other"),
      ],
      archivedThreads: [thread("archived", "t3/bfc349ae", "/worktree")],
    };
    const dispatch = (command: OrchestrationV2ServerCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        if (
          command.type === "thread.metadata.update" &&
          command.threadId === ThreadId.make("generated") &&
          scenario === "conflict"
        ) {
          return yield* new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Thread moved before branch metadata could be applied.",
          });
        }
        return { sequence: commands.length, storedEvents: [] };
      });
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
        writable
          ? [
              ["generated", "union", "t3/unify-converter-branches", "/worktree"],
              ["shared", "union", "t3/bfc349ae", "/link/worktree"],
              ["archived", "union", "t3/bfc349ae", "/worktree"],
            ]
          : [],
      );
    }).pipe(
      Effect.provide(
        WorktreeBranches.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Path.layer,
              FileSystem.layerNoop({
                realPath: (path) => Effect.succeed(path === "/link/worktree" ? "/worktree" : path),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                getShell: () =>
                  Effect.succeedSome({ workspaceRoot: "/repo" } as OrchestrationProjectShell),
              }),
              Layer.mock(GitVcsDriver.GitVcsDriver)({
                resolvePrimaryRemoteName: () => Effect.succeed("origin"),
                resolveDefaultBranchName: () => Effect.succeed("main"),
                execute: ({ cwd, args }) => {
                  const stdout =
                    args[0] === "symbolic-ref"
                      ? `refs/heads/${branch}\n`
                      : args[1] === "--git-common-dir"
                        ? scenario === "replaced" && cwd !== "/repo"
                          ? "/other/.git\n"
                          : "/repo/.git\n"
                        : args[0] === "worktree"
                          ? `branch refs/heads/${branch}\n`.repeat(scenario === "held" ? 2 : 1)
                          : "commit\n";
                  return Effect.succeed({
                    stdout,
                    stderr: "",
                    exitCode: ChildProcessSpawner.ExitCode(
                      scenario === "unborn" && args[1] === "--verify" ? 1 : 0,
                    ),
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
                },
              }),
              Layer.mock(Orchestrator.OrchestratorV2)({
                getShellSnapshot: (options) =>
                  Effect.succeed({
                    ...snapshot,
                    threads: snapshot.threads.filter(
                      (thread) => thread.worktreePath === options?.worktreePath,
                    ),
                    archivedThreads: snapshot.archivedThreads.filter(
                      (thread) => thread.worktreePath === options?.worktreePath,
                    ),
                  }),
                dispatch,
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
                streamBranchChanges: Stream.fromIterable([null, "t3/bfc349ae", branch]).pipe(
                  Stream.map((refName) => ({
                    cwd: "/worktree",
                    refName,
                  })),
                  Stream.ensuring(Deferred.succeed(reconciled, undefined)),
                ),
              }),
              Layer.mock(GitWorkflowService.GitWorkflowService)({
                currentBranch: () => Effect.succeed(branch),
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getShellSnapshot: () => Effect.succeed(snapshot),
                dispatch,
              }),
            ),
          ),
        ),
      ),
    );
  },
);
