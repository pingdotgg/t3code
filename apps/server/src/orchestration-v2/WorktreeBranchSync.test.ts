import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as WorktreeBranchSync from "./WorktreeBranchSync.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for branch reconciliation"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "worktree-branch-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

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
    );
  },
);

it.effect("preserves a provider attachment committed after branch planning", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:branch-race");
    const providerId = ProviderThreadId.make("provider:concurrent-attachment");
    const worktreePath = "/git-worktree";
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-branch-race"),
      threadId,
      projectId: ProjectId.make("project:branch-race"),
      title: "Branch race",
      modelSelection: { instanceId, model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "t3/temporary",
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
    const write = sink.write;
    let injected = false;
    const attach = Effect.gen(function* () {
      if (injected) return;
      injected = true;
      const now = yield* DateTime.now;
      yield* write({
        events: [
          {
            id: EventId.make("attach-during-branch-write"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerId,
              driver: adapter.driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      assert.equal((yield* projections.getThread(threadId)).activeProviderThreadId, providerId);
    }).pipe(Effect.orDie);
    const commitCommand = sink.commitCommand;
    // Provider ingestion writes outside the command lock, between planning and commit.
    using _commitSpy = vi
      .spyOn(sink, "commitCommand")
      .mockImplementation((input) => attach.pipe(Effect.andThen(commitCommand(input))));
    using _writeSpy = vi
      .spyOn(sink, "write")
      .mockImplementation((input) => attach.pipe(Effect.andThen(write(input))));
    const reconciled = yield* Deferred.make<void>();
    yield* Layer.build(WorktreeBranchSync.layer).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({}),
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            currentBranch: () => Effect.succeed("renamed"),
          }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            streamBranchChanges: Stream.make({ cwd: worktreePath, refName: "renamed" }).pipe(
              Stream.ensuring(Deferred.succeed(reconciled, undefined)),
            ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: orchestrator.getShellSnapshot,
            dispatch: orchestrator.dispatch,
          }),
        ),
      ),
    );
    yield* Deferred.await(reconciled);
    const result = yield* projections.getThread(threadId);
    assert.equal(injected, true);
    assert.equal(result.branch, "renamed");
    assert.equal(result.activeProviderThreadId, providerId);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
