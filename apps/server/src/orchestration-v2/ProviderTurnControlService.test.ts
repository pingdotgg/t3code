import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectFactId,
  ProjectKnowledgeError,
  ServerSettingsError,
  type ProjectKnowledgeDelivery,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { claudeProvider, disabledLayer, makeFixture } from "../pstack/PstackPack.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectKnowledge from "../project/knowledge/ProjectKnowledge.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          getLimitRecoveryWakeAt: () => Effect.die("unused getLimitRecoveryWakeAt"),
          getOpenRemoteDelegatedTasks: Effect.die("unused getOpenRemoteDelegatedTasks"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          listActiveSubagentThreadIds: () => Effect.die("unused listActiveSubagentThreadIds"),
          countThreads: () => Effect.die("unused countThreads"),
          listActiveShellIndex: () => Effect.die("unused listActiveShellIndex"),
          listOlderSettledThreads: () => Effect.die("unused listOlderSettledThreads"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          findGuestShareThreadId: () => Effect.die("unused findGuestShareThreadId"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getMessageCount: () => Effect.die("unused message count"),
          getSubagentCount: () => Effect.die("unused subagent count"),
          listAppOwnedChildThreadIds: () => Effect.die("unused listAppOwnedChildThreadIds"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getThreadRecords: () => Effect.die("unused record read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          isNodeStored: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getHeldQueuedRuns: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
          otherWorkingThreads: () => Effect.succeed([]),
          releaseUnlessBusy: () => Effect.succeed(true),
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(Layer.mock(ProjectKnowledge.ProjectKnowledge)({})),
        Layer.provide(disabledLayer),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.merge(layerProjection, layerSessionManager)),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

it.effect.each([
  true,
  false,
  "agent-authored",
  "notification",
  "delegated-completion",
  "no-mention",
  "plain-name",
  "record-only",
  "project-disabled",
  "pack-failure",
  "settings-failure",
] as const)("steer consumes pstack before native projection, enabled=%s", (mode) =>
  Effect.gen(function* () {
    const enabled = mode !== false;
    const authoredByUser = mode !== "agent-authored";
    const shouldExpand =
      enabled &&
      authoredByUser &&
      mode !== "notification" &&
      mode !== "delegated-completion" &&
      mode !== "no-mention" &&
      mode !== "plain-name";
    const fixture = yield* makeFixture(
      [claudeProvider],
      mode === "settings-failure"
        ? Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.fail(
              new ServerSettingsError({
                operation: "read-file",
                settingsPath: "/fixture/settings.json",
              }),
            ),
          })
        : undefined,
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${fixture.stateDir}/pstack`, { recursive: true });
    yield* fs.writeFileString(
      `${fixture.stateDir}/pstack/models.md`,
      "architect runners: claudeAgent/claude-opus-5-5 effort=xhigh fastMode=false",
    );
    if (mode === "pack-failure") yield* fs.remove(fixture.sourceRoot, { recursive: true });
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("pstack-steer");
    const providerSessionId = ProviderSessionId.make("pstack-steer-session");
    const providerThreadId = ProviderThreadId.make("pstack-steer-thread");
    const providerTurnId = ProviderTurnId.make("pstack-steer-turn");
    const messageId = MessageId.make("pstack-steer-message");
    const runId = RunId.make("pstack-steer-run");
    const attemptId = RunAttemptId.make("pstack-steer-attempt");
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "not_loaded",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const projection = makeProjection({
      now,
      threadId,
      providerThread,
      providerTurnId,
      attemptId,
    });
    const record = {
      version: 1 as const,
      kind: "skill" as const,
      contextId: ComposerContextId.make("pstack-steer"),
      name: "pstack:architect",
      label: "architect",
    };
    const native = {
      ...record,
      contextId: ComposerContextId.make("native-steer"),
      name: "native:review",
      label: "review",
    };
    const received: string[] = [];
    let threadReads = 0;
    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId,
      providerSession: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "running",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.empty,
      ensureThread: () => Effect.die("unused ensureThread"),
      resumeThread: () => Effect.die("unused resumeThread"),
      startTurn: () => Effect.die("unused startTurn"),
      steerTurn: (input) =>
        Effect.sync(() => {
          received.push(input.message.text);
        }),
      interruptTurn: () => Effect.die("unused interruptTurn"),
      respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
      readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
      rollbackThread: () => Effect.die("unused rollbackThread"),
      forkThread: () => Effect.die("unused forkThread"),
    };
    const layers = ProviderTurnControlService.layer.pipe(
      Layer.provide(Layer.mock(ProjectKnowledge.ProjectKnowledge)({})),
      Layer.provide(
        Layer.mergeAll(
          fixture.layer,
          fixture.settingsLayer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () =>
              Effect.sync(() => {
                threadReads += 1;
                return projection.thread;
              }),
            getThreadRecords: () =>
              Effect.succeed({
                ...projection,
                runs: [
                  {
                    id: runId,
                    threadId,
                    ordinal: 1,
                    providerInstanceId,
                    modelSelection,
                    providerThreadId,
                    userMessageId: messageId,
                    rootNodeId: null,
                    activeAttemptId: attemptId,
                    status: "running" as const,
                    requestedAt: now,
                    startedAt: now,
                    completedAt: null,
                    checkpointId: null,
                    contextHandoffId: null,
                    delegatedCompletion: {
                      disposition: "open" as const,
                      nextGeneration: 2,
                      delivery: { messageId, generation: 1, taskIds: [NodeId.make("child")] },
                    },
                  },
                ],
              }),
            getProviderControlContext: () =>
              Effect.succeed({
                providerThread,
                providerTurn: projection.providerTurns[0],
                attempt: undefined,
                run: { id: runId } as OrchestrationV2ThreadProjection["runs"][number],
                message: {
                  id: messageId,
                  text:
                    mode === "plain-name"
                      ? `Discuss pstack:architect ${formatComposerContextReference(native)}`
                      : mode === "no-mention"
                        ? `Refine ${formatComposerContextReference(native)}`
                        : `${mode === "record-only" ? "" : "Result mentions $pstack:architect then "}${formatComposerContextReference(record)} refine ${formatComposerContextReference(native)}`,
                  context: {
                    version: 1,
                    records:
                      mode === "no-mention" || mode === "plain-name" ? [native] : [record, native],
                  },
                  ...(mode === "notification"
                    ? {
                        notification: {
                          source: { kind: "command" },
                          outcome: "completed",
                          summary: "Task finished",
                        },
                      }
                    : {}),
                  ...(mode === "delegated-completion"
                    ? {
                        delegatedCompletion: {
                          parentRunId: runId,
                          generation: 1,
                          taskIds: [NodeId.make("child")],
                        },
                      }
                    : {}),
                  attachments: [],
                  createdBy: authoredByUser ? "user" : "agent",
                  creationSource: authoredByUser ? "web" : "server",
                } as unknown as OrchestrationV2ThreadProjection["messages"][number],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedSome(runtime),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      if (mode !== "settings-failure")
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          pstackEnabled: enabled,
          ...(mode === "project-disabled"
            ? {
                projectSettingsOverrides: {
                  [projection.thread.projectId]: {
                    providerInstances: { [claudeProvider.instanceId]: { enabled: false } },
                  },
                },
              }
            : {}),
        });
      yield* (yield* ProviderTurnControlService.ProviderTurnControlServiceV2).steer({
        threadId,
        providerSessionId,
        providerThreadId,
        providerTurnId,
        messageId,
      });
    }).pipe(Effect.provide(Layer.merge(layers, fixture.settingsLayer)));
    assert.equal(threadReads, shouldExpand ? 1 : 0);
    assert.lengthOf(received, 1);
    assert.include(received[0]!, "native:review");
    if (mode === "pack-failure" || mode === "settings-failure") {
      assert.include(received[0]!, "pstack is unavailable:");
      assert.include(received[0]!, "$pstack:architect");
      assert.notInclude(received[0]!, "<t3_pstack>");
    } else if (shouldExpand) {
      if (mode === "project-disabled")
        assert.include(received[0]!, "Fallback: architect runners seat 1");
      else assert.notInclude(received[0]!, "Fallback:");
      assert.include(received[0]!, "<t3_pstack>");
      assert.notInclude(received[0]!, "$pstack:architect");
    } else {
      assert.notInclude(received[0]!, "<t3_pstack>");
      if (mode !== "no-mention") assert.include(received[0]!, "pstack:architect");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "sent",
  "stale",
  "budget",
  "budget-null-turn-window",
  "uncertain",
  "turn-ended",
  "sent-replaced",
  "uncertain-replaced",
  "uncertain-replaced-legacy",
  "stale-during-history",
  "recovered-history",
  "current-history-budget",
  "delivered-knowledge-budget",
] as const)(
  "delivers selected knowledge through active steering with %s receipt semantics",
  (mode) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("knowledge-steer-thread");
      const projectId = ProjectId.make("knowledge-steer-project");
      const providerSessionId = ProviderSessionId.make("knowledge-steer-session");
      const providerThreadId = ProviderThreadId.make("knowledge-steer-provider-thread");
      const providerTurnId = ProviderTurnId.make("knowledge-steer-turn");
      const attemptId = RunAttemptId.make("knowledge-steer-attempt");
      const messageId = MessageId.make("knowledge-steer-message");
      const runId = RunId.make("knowledge-steer-run");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "knowledge-native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        ...(mode.startsWith("budget")
          ? { contextUsage: { usedTokens: 128_000, maxTokens: 128_000 } }
          : {}),
      };
      const projection = makeProjection({
        now,
        threadId,
        providerThread,
        providerTurnId,
        attemptId,
      });
      const historicalRunId = RunId.make("knowledge-steer-history-run");
      const historicalAttemptId = RunAttemptId.make("knowledge-steer-history-attempt");
      const historicalProviderTurnId = ProviderTurnId.make("knowledge-steer-history-turn");
      const hasLargeHistory = mode === "recovered-history" || mode === "current-history-budget";
      const history: OrchestrationV2ThreadProjection["turnItems"] = hasLargeHistory
        ? [
            {
              id: TurnItemId.make("knowledge-steer-history-item"),
              threadId,
              runId: historicalRunId,
              nodeId: null,
              providerThreadId,
              providerTurnId: historicalProviderTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId: MessageId.make("knowledge-steer-history-message"),
              inputIntent: "turn_start",
              text: "x".repeat(128_000),
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          ]
        : [];
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("knowledge-steer-context"),
        label: "Testing convention",
        knowledge: {
          environmentId: EnvironmentId.make("knowledge-steer-environment"),
          projectId,
          selections: [
            { kind: "fact" as const, factId: ProjectFactId.make("test-runner"), revision: 1 },
          ],
          maxBytes: 48000,
        },
      };
      const receipts: ProjectKnowledgeDelivery[] = [];
      const received: string[] = [];
      let resolved = 0;
      let completed = false;
      let replaced = false;
      let sourceChanged = false;
      const historyStarted = yield* Deferred.make<void>();
      const releaseHistory = yield* Deferred.make<void>();
      const uncertain = mode.startsWith("uncertain");
      const layers = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            disabledLayer,
            ServerSettings.layerTest(),
            Layer.mock(ProjectKnowledge.ProjectKnowledge)({
              nativeDeliveryEstimate: (target) =>
                Effect.sync(() => {
                  assert.deepEqual(target, {
                    projectId,
                    threadId,
                    providerInstanceId,
                    providerThreadId,
                    nativeThreadId: "knowledge-native-thread",
                  });
                  return mode === "delivered-knowledge-budget" ? 150_000 : 0;
                }),
              resolveForTurn: (context) =>
                Effect.suspend(() => {
                  resolved += 1;
                  if ((resolved > 1 && mode === "stale") || sourceChanged) {
                    return Effect.fail(
                      new ProjectKnowledgeError({ reason: "stale_context", projectId }),
                    );
                  }
                  if (resolved > 1 && mode === "turn-ended") completed = true;
                  return Effect.succeed({
                    context,
                    text: "Use the project-selected test runner.",
                    byteLength: 37,
                  });
                }),
              readDeliveryState: (target) =>
                Effect.sync(() => {
                  const matching = receipts.filter(
                    (receipt) =>
                      receipt.messageId === target.messageId &&
                      receipt.providerInstanceId === target.providerInstanceId &&
                      (target.scope === "attempt"
                        ? receipt.attemptId === target.attemptId &&
                          (receipt.providerThreadId === undefined ||
                            receipt.providerThreadId === target.providerThreadId)
                        : receipt.providerThreadId === target.providerThreadId &&
                          receipt.nativeThreadId === target.nativeThreadId &&
                          (receipt.nativeThreadId != null ||
                            receipt.attemptId === target.attemptId)),
                  );
                  return {
                    sent: matching.some((receipt) => receipt.status === "sent"),
                    sentThisAttempt: matching.some(
                      (receipt) =>
                        receipt.status === "sent" && receipt.attemptId === target.attemptId,
                    ),
                    uncertain: matching.some(
                      (receipt) => receipt.status === "prepared" || receipt.status === "uncertain",
                    ),
                  };
                }),
              recordDelivery: (receipt) =>
                Effect.sync(() => {
                  const index = receipts.findIndex(
                    (existing) =>
                      existing.attemptId === receipt.attemptId &&
                      existing.messageId === receipt.messageId,
                  );
                  if (index < 0) receipts.push(receipt);
                  else receipts[index] = receipt;
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed({ ...projection.thread, projectId }),
              getThreadRecords: () =>
                Effect.succeed({
                  ...projection,
                  attempts: [
                    ...projection.attempts,
                    {
                      ...projection.attempts[0]!,
                      id: historicalAttemptId,
                      runId: historicalRunId,
                      providerTurnId: historicalProviderTurnId,
                      nativeThreadId:
                        mode === "recovered-history"
                          ? "old-native-thread"
                          : "knowledge-native-thread",
                    },
                  ],
                  providerTurns: [
                    ...projection.providerTurns,
                    {
                      ...projection.providerTurns[0]!,
                      id: historicalProviderTurnId,
                      runAttemptId: historicalAttemptId,
                    },
                  ],
                }),
              getTurnStartHistory: () =>
                mode === "stale-during-history"
                  ? Deferred.succeed(historyStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseHistory)),
                      Effect.as([]),
                    )
                  : Effect.succeed(history),
              getProviderControlContext: (_threadId, input) =>
                Effect.succeed({
                  providerThread: replaced
                    ? {
                        ...providerThread,
                        nativeThreadRef: {
                          driver,
                          nativeId: "replacement-native-thread",
                          strength: "strong",
                        },
                      }
                    : providerThread,
                  providerTurn: {
                    ...projection.providerTurns[0]!,
                    status: completed ? "completed" : "running",
                    ...(mode === "budget-null-turn-window"
                      ? {
                          tokenUsage: {
                            usedTokens: 128_000,
                            maxTokens: null,
                            updatedAt: DateTime.formatIso(now),
                          },
                        }
                      : {}),
                  },
                  attempt:
                    input.attemptId === undefined
                      ? undefined
                      : {
                          ...projection.attempts[0]!,
                          id: attemptId,
                          runId,
                          ...(mode === "uncertain-replaced-legacy"
                            ? {}
                            : { nativeThreadId: "knowledge-native-thread" }),
                        },
                  run: replaced
                    ? undefined
                    : {
                        ...projection.runs[0]!,
                        id: runId,
                        activeAttemptId: attemptId,
                        providerInstanceId,
                        modelSelection,
                      },
                  message: {
                    id: input.messageId!,
                    threadId,
                    runId,
                    nodeId: null,
                    role: "user",
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                    text: `Follow this decision: ${formatComposerContextReference(record)}`,
                    context: { version: 1, records: [record] },
                    attachments: [],
                    createdBy: "user",
                    creationSource: "web",
                  } satisfies OrchestrationV2ThreadProjection["messages"][number],
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeedSome({
                  driver,
                  instanceId: providerInstanceId,
                  providerSessionId,
                  providerSession: {
                    id: providerSessionId,
                    driver,
                    providerInstanceId,
                    status: "running",
                    cwd: "/workspace",
                    model: modelSelection.model,
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  events: Stream.empty,
                  ensureThread: () => Effect.die("unused ensureThread"),
                  resumeThread: () => Effect.die("unused resumeThread"),
                  startTurn: () => Effect.die("unused startTurn"),
                  interruptTurn: () => Effect.die("unused interruptTurn"),
                  respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
                  readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
                  rollbackThread: () => Effect.die("unused rollbackThread"),
                  forkThread: () => Effect.die("unused forkThread"),
                  getModelContextWindow: () =>
                    mode === "delivered-knowledge-budget" ? 200_000 : undefined,
                  steerTurn: (input: ProviderAdapter.ProviderAdapterV2SteerInput) =>
                    Effect.suspend(() => {
                      received.push(input.message.text);
                      if (uncertain) completed = true;
                      return uncertain
                        ? Effect.fail(
                            new ProviderAdapter.ProviderAdapterSteerRunError({
                              driver,
                              providerThreadId,
                              providerTurnId,
                            }),
                          )
                        : Effect.void;
                    }),
                } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const input = { threadId, providerSessionId, providerThreadId, providerTurnId, messageId };
        const first = yield* mode === "stale-during-history"
          ? Effect.gen(function* () {
              const sending = yield* control.steer(input).pipe(Effect.result, Effect.forkChild);
              yield* Deferred.await(historyStarted);
              sourceChanged = true;
              yield* Deferred.succeed(releaseHistory, undefined);
              return yield* Fiber.join(sending);
            })
          : control.steer(input).pipe(Effect.result);
        if (mode.includes("replaced")) {
          assert.equal(first._tag, uncertain ? "Failure" : "Success");
          completed = true;
          replaced = true;
          if (mode === "uncertain-replaced-legacy") {
            const { providerThreadId: _destination, ...legacyReceipt } = receipts[0]!;
            receipts[0] = { ...legacyReceipt, nativeThreadId: null };
          }
          const retried = yield* control.steer(input).pipe(Effect.result);
          if (uncertain) {
            assert.equal(retried._tag, "Failure");
            if (retried._tag === "Failure") assert.notEqual(retried.failure.turnCompleted, true);
          } else {
            assert.equal(retried._tag, "Success");
          }
          assert.lengthOf(received, 1);
          return;
        }
        if (mode === "recovered-history") {
          assert.equal(first._tag, "Success");
          assert.lengthOf(received, 1);
          assert.equal(receipts[0]?.status, "sent");
          assert.include(received[0]!, "Use the project-selected test runner.");
        } else if (mode === "sent") {
          assert.equal(first._tag, "Success");
          completed = true;
          yield* control.steer(input);
          completed = false;
          yield* control.steer({ ...input, messageId: MessageId.make("knowledge-steer-followup") });
          assert.lengthOf(received, 2);
          assert.lengthOf(receipts, 2);
          assert.isTrue(receipts.every((receipt) => receipt.status === "sent"));
          assert.isTrue(
            received.every((text) => text.includes("Use the project-selected test runner.")),
          );
          assert.isTrue(
            received.every((text) => !text.includes("Selected project knowledge is unavailable")),
          );
        } else if (mode === "uncertain") {
          assert.equal(first._tag, "Failure");
          assert.equal((yield* control.steer(input).pipe(Effect.result))._tag, "Failure");
          assert.lengthOf(received, 1);
          assert.equal(receipts[0]?.status, "uncertain");
        } else {
          assert.equal(first._tag, "Failure");
          assert.lengthOf(received, 0);
          assert.equal(receipts[0]?.status, "failed");
        }
      }).pipe(Effect.provide(layers));
    }),
);
