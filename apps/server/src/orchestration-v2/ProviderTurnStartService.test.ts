import { ScheduledTaskId } from "@t3tools/contracts";
import * as PstackPack from "../pstack/PstackPack.ts";
import { claudeProvider, disabledLayer, makeFixture } from "../pstack/PstackPack.testkit.ts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import * as KnowledgePersistence from "../project/knowledge/persistence.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectKnowledge from "../project/knowledge/ProjectKnowledge.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  ComposerContextId,
  EnvironmentId,
  ProjectFactId,
  ProjectKnowledgeError,
  type ProjectKnowledgeDelivery,
  CheckpointScopeId,
  ContextTransferId,
  GitCommandError,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  ContextHandoffId,
  TurnItemId,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { withInlineContext } from "./ContextHandoffDelivery.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
// fs.realpath applies `..` and `.` before following symlinks.
const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};
const layerWorktreeLocation = (worktreesDir = managedWorktreesDir) =>
  Layer.mergeAll(
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest(),
  );

function startWithMissingWorktree(
  worktreePath: string,
  realPaths: Record<string, string> = {
    [managedWorktreesDir]: managedWorktreesDir,
    [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
  },
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const listLocalBranchNames = vi.fn(() => Effect.succeed(["feature/restore"]));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(disabledLayer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectKnowledge.ProjectKnowledge)({}),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.succeed(false),
          realPath: (target: string) =>
            normalize(target) in realPaths
              ? Effect.succeed(realPaths[normalize(target)])
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        layerWorktreeLocation(),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees,
          createWorktree,
          listLocalBranchNames,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    start,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReads: () => projectionReadCount,
  };
}

it.each([
  {
    label: "<managed>/<repo>/<branch>",
    worktreePath: `${managedWorktreesDir}/project/feature-restore`,
    recreated: true,
  },
  {
    label: "the real path of a symlinked managed folder",
    worktreePath: "/real-worktrees/project/feature-restore",
    realPaths: { [managedWorktreesDir]: "/real-worktrees", "/real-worktrees": "/real-worktrees" },
    recreated: true,
  },
  {
    label: "a path outside the managed folder",
    worktreePath: "/tmp/provider-turn-start-project/.git/hooks",
    recreated: false,
  },
  {
    label: "a symlink inside the managed folder that leads out",
    worktreePath: `${managedWorktreesDir}/project/hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: "/tmp/provider-turn-start-project/.git",
    },
    recreated: false,
  },
  {
    label: "a folder nested below a worktree",
    worktreePath: `${managedWorktreesDir}/project/feature-restore/link/hooks`,
    recreated: false,
  },
  {
    label: "'..' out of the managed folder",
    worktreePath: `${managedWorktreesDir}/project/../../outside`,
    recreated: false,
  },
  {
    // Left raw on purpose: git follows `link` before applying `..`.
    label: "'..' after a symlink inside the managed folder",
    worktreePath: `${managedWorktreesDir}/project/x/link/../../hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
      [`${managedWorktreesDir}/project/x`]: `${managedWorktreesDir}/project/x`,
      [`${managedWorktreesDir}/project/x/link`]: "/tmp/provider-turn-start-project/.git/refs/heads",
    },
    recreated: false,
  },
  { label: "a relative path", worktreePath: "project/feature-restore", recreated: false },
])("recreates a missing worktree only at the managed location: $label", async (input) => {
  const harness = startWithMissingWorktree(input.worktreePath, input.realPaths);
  await harness.start;
  expect(harness.createWorktree).toHaveBeenCalledTimes(input.recreated ? 1 : 0);
});

function makeLocalCommandHarness(input: {
  readonly pstack?: PstackPack.PstackPack["Service"];
  readonly text: string;
  readonly knowledgeStore?: Effect.Success<typeof KnowledgePersistence.makeStore>;
  readonly initialDeliveries?: ReadonlyArray<ProjectKnowledgeDelivery>;
  readonly recoveryNativeId?: string;
  readonly modelContextWindow?: number;
  readonly resolveKnowledge?: ProjectKnowledge.ProjectKnowledge["Service"]["resolveForTurn"];
  readonly readSentDeliveries?: ProjectKnowledge.ProjectKnowledge["Service"]["readSentDeliveries"];
  readonly worktreePath?: string;
  readonly worktreesDir?: string;
  readonly workspaceRoot?: string;
  readonly gitWorkflow?: GitWorkflow.GitWorkflowService["Service"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly ensureThreadFailure?: unknown;
  readonly historyReadFailureAfterFallback?: unknown;
  readonly resumeFailure?: ProviderAdapter.ProviderAdapterV2Error;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  readonly previousTurn?: {
    readonly runStatus: "failed" | "completed";
    readonly turnStatus: "running" | "completed" | "interrupted";
    readonly differentThread?: boolean;
    readonly liveSession?: boolean;
    readonly interruptFailure?: boolean;
    readonly interruptCurrentRun?: boolean;
  };
  /**
   * A side chat whose context targets this run, an earlier run that failed or was cancelled before
   * the provider, or an earlier run that delivered it. `nativeForkFrom` plans a native fork of the
   * parent. `switchedProvider` puts the earlier run and its context on another provider thread.
   */
  readonly sideChat?: {
    readonly contextRun: "current" | "failed" | "cancelled" | "delivered";
    readonly nativeForkFrom?: "idle" | "busy";
    readonly switchedProvider?: boolean;
    readonly threadRuntimeMode?: OrchestrationV2ThreadProjection["thread"]["runtimeMode"];
  };
}) {
  const settledRuns: Array<string> = [];
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-native-account-command"),
      branch: input.worktreePath === undefined ? null : "feature/restore",
      worktreePath: input.worktreePath ?? null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  const parentThreadId = ThreadId.make("side-chat-parent");
  const parentRunId = RunId.make("side-chat-parent-run");
  const parentProviderThread = {
    ...providerThread,
    id: ProviderThreadId.make("side-chat-parent-provider-thread"),
    appThreadId: parentThreadId,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-parent-native",
      strength: "strong" as const,
    },
  };
  const parentProviderTurn = (ordinal: number, attemptRunId: RunId) => ({
    attempt: {
      ...projection.attempts[0]!,
      id: RunAttemptId.make(`side-chat-parent-attempt-${ordinal}`),
      runId: attemptRunId,
      providerThreadId: parentProviderThread.id,
      status: "completed" as const,
    },
    turn: {
      id: ProviderTurnId.make(`side-chat-parent-turn-${ordinal}`),
      providerThreadId: parentProviderThread.id,
      nodeId: rootNodeId,
      runAttemptId: RunAttemptId.make(`side-chat-parent-attempt-${ordinal}`),
      nativeTurnRef: {
        driver: providerThread.driver,
        nativeId: `side-chat-parent-native-turn-${ordinal}`,
        strength: "strong" as const,
      },
      ordinal,
      status: "completed" as const,
      startedAt: now,
      completedAt: now,
    },
  });
  const parentRolledBackRunId = RunId.make("side-chat-parent-rolled-back-run");
  const parentTurns = [
    parentProviderTurn(1, parentRunId),
    parentProviderTurn(2, parentRolledBackRunId),
  ];
  const parentRecords = {
    ...projection,
    thread: { ...projection.thread, id: parentThreadId },
    runs: [
      {
        ...run,
        id: parentRunId,
        threadId: parentThreadId,
        ordinal: 1,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: parentTurns[0]!.attempt.id,
        status: "completed" as const,
        completedAt: now,
      },
      {
        ...run,
        id: parentRolledBackRunId,
        threadId: parentThreadId,
        ordinal: 2,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: parentTurns[1]!.attempt.id,
        status: "rolled_back" as const,
        completedAt: now,
      },
      ...(input.sideChat?.nativeForkFrom === "busy"
        ? [
            {
              ...run,
              id: RunId.make("side-chat-parent-busy-run"),
              threadId: parentThreadId,
              ordinal: 3,
              providerThreadId: parentProviderThread.id,
              status: "running" as const,
            },
          ]
        : []),
    ],
    providerThreads: [parentProviderThread],
    attempts: parentTurns.map(({ attempt }) => attempt),
    providerTurns: parentTurns.map(({ turn }) => turn),
    turnItems: [],
  };
  if (input.sideChat !== undefined) {
    const earlierRunId = RunId.make("side-chat-earlier-run");
    projection = {
      ...projection,
      thread: {
        ...projection.thread,
        runtimeMode: input.sideChat.threadRuntimeMode ?? "full-access",
        lineage: {
          parentThreadId,
          relationshipToParent: "fork",
          rootThreadId: parentThreadId,
          sideChat: true,
        },
      },
      runs:
        input.sideChat.contextRun === "current"
          ? projection.runs
          : [
              {
                ...run,
                id: earlierRunId,
                ordinal: 1,
                userMessageId: MessageId.make("side-chat-earlier-message"),
                activeAttemptId: RunAttemptId.make("side-chat-earlier-attempt"),
                ...(input.sideChat.switchedProvider
                  ? { providerThreadId: oldProviderThreadId }
                  : {}),
                status:
                  input.sideChat.contextRun === "delivered"
                    ? "completed"
                    : input.sideChat.contextRun,
                completedAt: now,
              },
              run,
            ],
      contextTransfers:
        input.sideChat.nativeForkFrom === undefined
          ? []
          : [
              {
                id: ContextTransferId.make("side-chat-fork"),
                type: "fork",
                sourceThreadId: parentThreadId,
                targetThreadId: threadId,
                sourcePoint: { threadId: parentThreadId, runId: parentRunId },
                basePoint: null,
                sourceProviderInstanceId: newInstanceId,
                targetProviderInstanceId: newInstanceId,
                targetRunId: runId,
                status: "pending",
                resolution: null,
                createdBy: "user",
                error: null,
                createdAt: now,
                updatedAt: now,
                consumedAt: null,
              },
            ],
      contextHandoffs: [
        {
          id: ContextHandoffId.make("side-chat-context"),
          transferId: ContextTransferId.make("side-chat-fork"),
          threadId,
          targetRunId: input.sideChat.contextRun === "current" ? runId : earlierRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.sideChat.switchedProvider
            ? oldProviderThreadId
            : providerThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "SIDE_CHAT_CONTEXT",
          createdByProviderInstanceId: null,
          createdAt: now,
          updatedAt: now,
          ...(input.sideChat.contextRun === "delivered"
            ? {
                delivery: {
                  nativeThreadId: "side-chat-native",
                  status: "inline" as const,
                  itemIds: [],
                },
              }
            : {}),
        },
      ],
    };
  }
  if ("historyReadFailureAfterFallback" in input || "resumeFailure" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const previousTurnId = ProviderTurnId.make("previous-provider-turn");
  if (input.previousTurn !== undefined) {
    const previousRunId = RunId.make("previous-failed-run");
    const previousAttemptId = RunAttemptId.make("previous-failed-attempt");
    const previousProviderThreadId = input.previousTurn.differentThread
      ? oldProviderThreadId
      : providerThreadId;
    projection = {
      ...projection,
      runs: [
        {
          ...run,
          id: previousRunId,
          ordinal: 1,
          status: input.previousTurn.runStatus,
          rootNodeId: NodeId.make("previous-root"),
          activeAttemptId: previousAttemptId,
          providerThreadId: previousProviderThreadId,
          completedAt: now,
        },
        run,
      ],
      providerThreads: [
        {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "existing-native-conversation",
            strength: "strong",
          },
        },
      ],
      providerTurns: [
        {
          id: previousTurnId,
          providerThreadId: previousProviderThreadId,
          nodeId: NodeId.make("previous-root"),
          runAttemptId: previousAttemptId,
          ordinal: 1,
          nativeTurnRef: null,
          status: input.previousTurn.turnStatus,
          startedAt: now,
          completedAt: input.previousTurn.turnStatus === "running" ? null : now,
        },
      ],
    };
  }
  let providerBusy =
    input.previousTurn?.runStatus === "failed" &&
    input.previousTurn.turnStatus === "running" &&
    !input.previousTurn.differentThread &&
    input.previousTurn.liveSession !== false;
  const interruptTurn = vi.fn((request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
    Effect.gen(function* () {
      expect(request.providerTurnId).toBe(previousTurnId);
      expect(request.providerThread.id).toBe(providerThreadId);
      if (input.previousTurn?.interruptFailure) {
        return yield* new ProviderAdapter.ProviderAdapterInterruptError({
          driver: providerThread.driver,
          providerThreadId,
          providerTurnId: request.providerTurnId,
          cause: "provider interrupt failed",
        });
      }
      providerBusy = false;
      if (input.previousTurn?.interruptCurrentRun) interruptRun();
    }),
  );
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const nativeStart = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>(
    () => Effect.void,
  );
  const fallbackEnsureThread = vi.fn(() => Effect.succeed(providerThread));
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        input.resumeFailure ??
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: "native thread is gone",
          }),
      ),
    ensureThread: fallbackEnsureThread,
  };
  const providerSession = {
    id: providerSessionId,
    driver: providerThread.driver,
    providerInstanceId: newInstanceId,
    status: "ready",
    cwd: "/tmp/native-account-command",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const startTurn = vi.fn((_turn: ProviderAdapter.ProviderAdapterV2TurnInput) => Effect.void);
  const sideChatThread = {
    ...providerThread,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-native",
      strength: "strong" as const,
    },
  };
  const forkThread = vi.fn((_fork: ProviderAdapter.ProviderAdapterV2ForkThreadInput) =>
    Effect.succeed(sideChatThread),
  );
  const sideChatSession = {
    driver: providerThread.driver,
    providerSession,
    ensureThread: () => Effect.succeed(sideChatThread),
    resumeThread: () => Effect.succeed(sideChatThread),
    forkThread,
    startTurn,
  };
  const open = vi.fn(() =>
    input.sideChat !== undefined
      ? Effect.succeed(sideChatSession as never)
      : input.interruptOpen === true
        ? Effect.interrupt
        : "historyReadFailureAfterFallback" in input || "resumeFailure" in input
          ? Effect.succeed(resumeFallbackSession as never)
          : "ensureThreadFailure" in input
            ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
            : "openFailure" in input
              ? Effect.sync(() => {
                  if (input.interruptRunBeforeOpenFailure === true) interruptRun();
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderSessionManager.ProviderSessionOpenError({
                        instanceId: newInstanceId,
                        providerSessionId,
                        cause: input.openFailure,
                      }),
                    ),
                  ),
                )
              : input.failReadsAfterRunning === true || input.previousTurn !== undefined
                ? Effect.succeed({
                    driver: providerThread.driver,
                    providerSession,
                    startTurn: nativeStart,
                    getModelContextWindow: () => input.modelContextWindow,
                    ensureThread: () =>
                      Effect.succeed({
                        ...providerThread,
                        nativeThreadRef: {
                          driver: providerThread.driver,
                          nativeId: input.recoveryNativeId ?? "existing-native-conversation",
                          strength: "strong" as const,
                        },
                      }),
                    resumeThread: () => Effect.succeed(projection.providerThreads.at(-1)),
                  } as never)
                : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >((runInput) =>
    input.sideChat !== undefined
      ? runInput.session.startTurn(runInput as never).pipe(Effect.orDie)
      : input.failReadsAfterRunning === true || input.previousTurn !== undefined
        ? Effect.suspend(() =>
            providerBusy ? Effect.die("The previous provider turn is still running.") : Effect.void,
          )
        : Effect.die("A local command must not start a native turn."),
  );
  let executionStarted = false;
  // Startup can recheck a running run before handing it to native execution.
  // Inject storage failure at that boundary so the long-lived controls are exercised.
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true && executionStarted
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    "writeFailure" in input
      ? Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: input.writeFailure,
          }),
        )
      : Effect.sync(() => {
          const current = projection.runs.find((candidate) => candidate.id === runId);
          const committed =
            current !== undefined &&
            current.activeAttemptId === activeAttemptId &&
            current.status === expectedStatus;
          if (committed) {
            for (const event of incoming) {
              expect(isDomainEvent(event)).toBe(true);
              events.push(event);
              projection = ProjectionStore.applyToProjection(projection, event);
            }
          }
          return { committed, storedEvents: [] };
        }),
  );
  const resolveRuntimePolicy = vi.fn(
    ({ thread }: Parameters<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>[0]) =>
      Effect.succeed({
        cwd: thread.worktreePath ?? "/tmp/native-account-command",
        runtimeMode: thread.runtimeMode,
      } as never),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(() =>
    Effect.succeed({} as never),
  );
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>((id) =>
    Effect.succeed(id === parentThreadId ? parentRecords : projection),
  );
  const getTurnStartContext = vi.fn(() =>
    Effect.succeed({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const knowledgeDeliveries: Array<ProjectKnowledgeDelivery> = [...(input.initialDeliveries ?? [])];
  const matchingKnowledgeDeliveries = (target: KnowledgePersistence.DeliveryStateInput) => {
    const latest = [
      ...new Map(
        knowledgeDeliveries.map((receipt) => [
          JSON.stringify([receipt.attemptId, receipt.messageId]),
          receipt,
        ]),
      ).values(),
    ];
    return latest.filter(
      (receipt) =>
        receipt.projectId === target.projectId &&
        receipt.threadId === target.threadId &&
        receipt.messageId === target.messageId &&
        receipt.providerInstanceId === target.providerInstanceId &&
        (target.scope === "attempt"
          ? receipt.attemptId === target.attemptId &&
            (receipt.providerThreadId === undefined ||
              receipt.providerThreadId === target.providerThreadId)
          : receipt.providerThreadId === target.providerThreadId &&
            receipt.nativeThreadId === target.nativeThreadId &&
            (receipt.nativeThreadId != null || receipt.attemptId === target.attemptId)),
    );
  };
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      input.pstack ? Layer.succeed(PstackPack.PstackPack, input.pstack) : disabledLayer,
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectKnowledge.ProjectKnowledge)({
          ...(input.resolveKnowledge ? { resolveForTurn: input.resolveKnowledge } : {}),
          ...(input.readSentDeliveries ? { readSentDeliveries: input.readSentDeliveries } : {}),
          nativeDeliveryEstimate: (target) =>
            input.knowledgeStore
              ? input.knowledgeStore.nativeDeliveryEstimate(target).pipe(Effect.orDie)
              : Effect.succeed(0),
          markDeliveryUncertain: (target) =>
            Effect.gen(function* () {
              const updatedAt = DateTime.formatIso(yield* DateTime.now);
              if (input.knowledgeStore)
                return yield* input.knowledgeStore
                  .markDeliveryUncertain(target, updatedAt)
                  .pipe(Effect.orDie);
              for (const receipt of matchingKnowledgeDeliveries(target)) {
                if (receipt.status === "prepared")
                  knowledgeDeliveries.push({ ...receipt, status: "uncertain", updatedAt });
              }
            }),
          readDeliveryState: (target) =>
            input.knowledgeStore
              ? input.knowledgeStore.readDeliveryState(target).pipe(Effect.orDie)
              : Effect.sync(() => {
                  const matching = matchingKnowledgeDeliveries(target);
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
          readDeliveries: (request) =>
            input.knowledgeStore
              ? input.knowledgeStore
                  .deliveries(request.projectId, request.threadId, request.messageId)
                  .pipe(
                    Effect.orDie,
                    Effect.map((deliveries) => ({
                      deliveries: deliveries.map((delivery) => ({
                        ...delivery,
                        items: delivery.items.map((item) => ({
                          ...item,
                          current: "current" as const,
                        })),
                      })),
                    })),
                  )
              : Effect.succeed({
                  deliveries: knowledgeDeliveries.map((delivery) => ({
                    ...delivery,
                    items: delivery.items.map((item) => ({ ...item, current: "current" as const })),
                  })),
                }),
          recordDelivery: (delivery) =>
            input.knowledgeStore
              ? input.knowledgeStore.recordDelivery(delivery).pipe(Effect.orDie)
              : Effect.sync(() => {
                  knowledgeDeliveries.push(delivery);
                }),
        }),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: (request) =>
            input.recoveryNativeId === undefined && input.sideChat?.nativeForkFrom === undefined
              ? Effect.die("history read must fail first")
              : Effect.succeed({
                  id: ContextHandoffId.make(
                    input.sideChat ? "side-chat-fork-context" : "recovery-handoff",
                  ),
                  ...request,
                  status: "ready",
                  summaryMessageId: null,
                  summaryText: input.sideChat ? "PARENT_HISTORY" : "Recovered history",
                  createdByProviderInstanceId: input.sideChat ? request.toProviderInstanceId : null,
                  updatedAt: request.createdAt,
                } as OrchestrationV2ContextHandoff),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        layerWorktreeLocation(input.worktreesDir),
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        input.gitWorkflow === undefined
          ? Layer.mock(GitWorkflow.GitWorkflowService)({
              pruneWorktrees: () => Effect.void,
              listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
              createWorktree,
            })
          : Layer.succeed(GitWorkflow.GitWorkflowService, input.gitWorkflow),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              workspaceRoot: input.workspaceRoot ?? "/tmp/native-account-project",
            } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            !("historyReadFailureAfterFallback" in input)
              ? Effect.succeed([])
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: input.historyReadFailureAfterFallback,
                  }),
                ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
          get: () =>
            Effect.succeed(
              input.previousTurn?.liveSession === false
                ? Option.none()
                : Option.some({
                    driver: providerThread.driver,
                    providerSessionId,
                    interruptTurn,
                  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
            ),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun: (request) =>
            Effect.sync(() => {
              executionStarted = true;
            }).pipe(Effect.andThen(() => startRootRun(request))),
        }),
        Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
          runStarted: () => Effect.void,
          turnCompleted: () => Effect.void,
          runSettled: (report) => Effect.sync(() => void settledRuns.push(report.status)),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
      ),
    ),
  );
  return {
    settledRuns,
    getThreadRecords,
    getTurnStartContext,
    nativeStart,
    knowledgeDeliveries,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    fallbackEnsureThread,
    writeIfRunCurrent,
    startRootRun,
    startTurn,
    forkThread,
    interruptTurn,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect(
  "recovers the local or pushed thread tip, else the current branch, remote default, or detached HEAD",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-recreate-repo-" });
      const workspaceRoot = path.join(root, "project");
      const originRoot = path.join(root, "origin.git");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "restore");
      yield* fileSystem.makeDirectory(workspaceRoot);
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        driver
          .execute({ operation: "test.worktreeRecovery", cwd, args })
          .pipe(Effect.map((result) => result.stdout.trim()));
      const branchConfig = (key: string) =>
        git(workspaceRoot, ["config", "--get", `branch.feature/restore.${key}`]).pipe(
          Effect.orElseSucceed(() => ""),
        );
      yield* git(root, ["init", "--bare", "-b", "main", originRoot]);
      yield* git(workspaceRoot, ["init", "-b", "main"]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* git(workspaceRoot, ["commit", "--allow-empty", "-m", "base"]);
      const baseTip = yield* git(workspaceRoot, ["rev-parse", "HEAD"]);
      yield* git(workspaceRoot, ["remote", "add", "origin", originRoot]);
      yield* git(workspaceRoot, ["push", "origin", "main"]);
      yield* git(workspaceRoot, ["remote", "set-head", "origin", "main"]);
      yield* git(workspaceRoot, ["worktree", "add", "-b", "feature/restore", worktreePath]);
      yield* fileSystem.writeFileString(path.join(worktreePath, "thread.txt"), "thread work");
      yield* git(worktreePath, ["add", "."]);
      yield* git(worktreePath, ["commit", "-m", "thread tip"]);
      const threadTip = yield* git(worktreePath, ["rev-parse", "HEAD"]);
      yield* git(workspaceRoot, ["switch", "-c", "project-current"]);
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "project.txt"),
        "new project code",
      );
      yield* git(workspaceRoot, ["add", "."]);
      yield* git(workspaceRoot, ["commit", "-m", "project tip"]);
      const projectTip = yield* git(workspaceRoot, ["rev-parse", "HEAD"]);
      expect(projectTip).not.toBe(threadTip);
      // Tags must neither hide the thread branch nor select a different recovery tip.
      yield* git(workspaceRoot, ["tag", "feature/restore", projectTip]);
      yield* git(workspaceRoot, ["tag", "project-current", threadTip]);
      yield* git(workspaceRoot, ["tag", "origin/feature/restore", threadTip]);

      const expectedTips = {
        retained: { tip: threadTip, file: "thread.txt", upstream: null, base: "" },
        deleted: { tip: projectTip, file: "project.txt", upstream: null, base: "project-current" },
        pushed: {
          tip: threadTip,
          file: "thread.txt",
          upstream: "refs/remotes/origin/feature/restore",
          base: "",
        },
        "pushed-detached": {
          tip: threadTip,
          file: "thread.txt",
          upstream: "refs/remotes/origin/feature/restore",
          base: "",
        },
        detached: { tip: baseTip, file: null, upstream: null, base: "main" },
        "detached-no-remote": { tip: projectTip, file: "project.txt", upstream: null, base: "" },
      } as const;
      // Reuse the workflow across turns so recovery cannot select a cached project branch.
      for (const scenario of Object.keys(expectedTips) as Array<keyof typeof expectedTips>) {
        const expected = expectedTips[scenario];
        if (scenario === "pushed") {
          yield* git(workspaceRoot, ["push", "origin", `${threadTip}:refs/heads/feature/restore`]);
          yield* git(workspaceRoot, ["fetch", "origin"]);
        }
        if (scenario === "pushed-detached") {
          yield* git(workspaceRoot, ["switch", "--detach"]);
          expect(yield* git(workspaceRoot, ["branch", "--show-current"])).toBe("");
        }
        if (scenario === "detached") {
          yield* git(workspaceRoot, ["push", "origin", "--delete", "feature/restore"]);
        }
        if (scenario === "detached-no-remote") {
          yield* git(workspaceRoot, ["remote", "remove", "origin"]);
        }
        yield* fileSystem.remove(worktreePath, { recursive: true });
        if (scenario !== "retained") {
          yield* git(workspaceRoot, ["worktree", "prune"]);
          yield* git(workspaceRoot, ["branch", "-D", "feature/restore"]);
        }
        const harness = makeLocalCommandHarness({
          text: "Continue",
          workspaceRoot,
          worktreePath,
          worktreesDir,
          fileSystem,
          gitWorkflow,
          failReadsAfterRunning: true,
        });
        const open = harness.open.getMockImplementation()!;
        harness.open.mockImplementation(() =>
          Effect.gen(function* () {
            expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature/restore");
            expect(yield* git(worktreePath, ["rev-parse", "HEAD"])).toBe(expected.tip);
            for (const file of ["thread.txt", "project.txt"]) {
              expect(yield* fileSystem.exists(path.join(worktreePath, file))).toBe(
                file === expected.file,
              );
            }
            expect(yield* branchConfig("merge")).toBe(
              expected.upstream === null ? "" : "refs/heads/feature/restore",
            );
            if (expected.upstream !== null) {
              expect(
                yield* git(worktreePath, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
              ).toBe(expected.upstream);
            }
            expect(yield* branchConfig("t3-merge-base")).toBe(expected.base);
            return yield* open();
          }).pipe(Effect.orDie),
        );

        yield* harness.start;

        expect(harness.open).toHaveBeenCalledOnce();
        expect(harness.startRootRun).toHaveBeenCalledWith(
          expect.objectContaining({
            runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
          }),
        );
        expect(harness.projection().runs.at(-1)?.status).toBe("running");
      }
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

effectIt.effect(
  "preserves recreation interrupts and retries, then fails the final attempt before provider start",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-recreate-failure-",
      });
      const worktreePath = path.join(worktreesDir, "project", "restore");
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreesDir,
        worktreePath,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementationOnce(() => Effect.interrupt);
      harness.createWorktree.mockImplementation(() =>
        Effect.fail(
          new GitCommandError({
            operation: "worktree-add",
            command: "git worktree add",
            cwd: "/tmp/native-account-project",
            detail: "fatal: private git diagnostic",
          }),
        ),
      );

      const interrupted = yield* Effect.exit(harness.start);
      expect(interrupted._tag).toBe("Failure");
      if (interrupted._tag === "Failure")
        expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
      expect(harness.events).toEqual([]);
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");

      const retry = yield* Effect.result(harness.startWithRetry);
      expect(retry).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderTurnStartError" } });
      expect(harness.events).toEqual([]);
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");

      yield* harness.start;
      expect(harness.createWorktree).toHaveBeenCalledTimes(3);
      expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          failure: {
            message: `Could not recreate the worktree for branch 'feature/restore' at ${worktreePath}.`,
          },
        },
      ]);
      expect(JSON.stringify(harness.events)).not.toContain("private git diagnostic");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

effectIt.effect("recovers an abandoned failed turn before continuing its native conversation", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.projection().providerTurns[0]).toMatchObject({
      status: "interrupted",
      completedAt: expect.anything(),
    });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeThreadRef?.nativeId).toBe(
      "existing-native-conversation",
    );
  }),
);

effectIt.effect.each([
  { contextRun: "current", runtimeMode: "full-access", context: "SIDE_CHAT_CONTEXT" },
  { contextRun: "failed", runtimeMode: "full-access", context: "SIDE_CHAT_CONTEXT" },
  { contextRun: "cancelled", runtimeMode: "full-access", context: "SIDE_CHAT_CONTEXT" },
  {
    contextRun: "failed",
    switchedProvider: true,
    runtimeMode: "full-access",
    context: "SIDE_CHAT_CONTEXT",
  },
  { contextRun: "delivered", runtimeMode: "full-access", context: "" },
  {
    contextRun: "current",
    threadRuntimeMode: "approval-required",
    runtimeMode: "approval-required",
    context: "SIDE_CHAT_CONTEXT",
  },
] as const)(
  "sends side chat context inline once, for the first turn that reaches the provider: %j",
  ({ runtimeMode, context, ...sideChat }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "What is the main thread doing?",
        sideChat,
      });

      yield* harness.start;

      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({ runtimePolicy: expect.objectContaining({ runtimeMode }) }),
      );
      expect(harness.startTurn.mock.calls.map(([turn]) => turn.message.text)).toEqual([
        withInlineContext(context, "What is the main thread doing?"),
      ]);
      expect(harness.projection().contextHandoffs).toMatchObject([
        {
          id: "side-chat-context",
          toProviderThreadId: "new-provider-thread",
          delivery: { nativeThreadId: "side-chat-native", status: "inline" },
        },
      ]);
    }),
);

effectIt.effect.each([
  { nativeForkFrom: "idle", forks: true, transferStatus: "consumed", handoffIds: [] },
  {
    nativeForkFrom: "busy",
    forks: false,
    transferStatus: "resolved_portable",
    handoffIds: ["side-chat-fork-context"],
  },
] as const)(
  "runs a planned native side chat fork when the parent is $nativeForkFrom",
  ({ nativeForkFrom, forks, transferStatus, handoffIds }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "What is the main thread doing?",
        sideChat: { contextRun: "current", nativeForkFrom },
      });

      yield* harness.start;

      expect(harness.forkThread).toHaveBeenCalledTimes(forks ? 1 : 0);
      // The parent's rolled-back turn is gone from its native conversation.
      expect(
        harness.forkThread.mock.calls[0]?.[0].sourceProviderTurns?.map((turn) => turn.id),
      ).toEqual(forks ? ["side-chat-parent-turn-1"] : undefined);
      expect(harness.projection().contextTransfers).toMatchObject([
        { id: "side-chat-fork", status: transferStatus },
      ]);
      expect(harness.startTurn.mock.calls[0]?.[0].message.text.includes("PARENT_HISTORY")).toBe(
        !forks,
      );
      expect(harness.projection().providerThreads[0]?.handoffIds).toEqual(handoffIds);
    }),
);

effectIt.effect.each([
  { runStatus: "failed", turnStatus: "completed" },
  { runStatus: "completed", turnStatus: "completed" },
  { runStatus: "failed", turnStatus: "running", differentThread: true },
  { runStatus: "failed", turnStatus: "running", liveSession: false },
  { runStatus: "failed", turnStatus: "interrupted", interruptFailure: true },
] as const)("continues without interrupting when recovery does not apply: %j", (previousTurn) =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", previousTurn });

    yield* harness.start;

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
  }),
);

effectIt.effect("does not start another turn when abandoned-turn cleanup fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

effectIt.effect("retries abandoned-turn cleanup without failing the continuation early", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not start the continuation if recording recovery fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.projection().providerTurns[0]?.status).toBe("running");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not resume a continuation stopped while recovery was in flight", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptCurrentRun: true },
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect.each(["cleanup-first", "startup-first"])(
  "coordinates provider startup with %s",
  (order) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-start-" });
      const worktreePath = path.join(workspaceRoot, "project", "worktree");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const release = yield* Deferred.make<void>();
      const openEntered = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        worktreesDir: workspaceRoot,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementation(() =>
        fileSystem.makeDirectory(worktreePath).pipe(Effect.as({} as never), Effect.orDie),
      );
      const open = harness.open.getMockImplementation()!;
      harness.open.mockImplementation(() =>
        Effect.gen(function* () {
          expect(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie)).toBe(true);
          yield* Deferred.succeed(openEntered, undefined);
          if (order === "startup-first") yield* Deferred.await(release);
          return yield* open();
        }),
      );
      let cleanupEntered = false;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          else {
            expect(harness.projection().providerSessions).toHaveLength(1);
            expect(harness.projection().runs.at(-1)?.status).toBe("running");
          }
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") expect(harness.open).not.toHaveBeenCalled();
      if (order === "startup-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "startup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "startup-first") expect(cleanupEntered).toBe(false);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      yield* Fiber.join(startup);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      if (order === "cleanup-first") {
        expect(harness.createWorktree).toHaveBeenCalledWith({
          cwd: "/tmp/native-account-project",
          refName: "feature/restore",
          path: worktreePath,
        });
      }
      expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({ worktreePath }),
        }),
      );
      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
      expect(harness.startRootRun).toHaveBeenCalledWith(
        expect.objectContaining({
          appThread: expect.objectContaining({ worktreePath }),
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

effectIt.effect("reads current startup state after waiting for the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-fresh-state";
    const release = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    harness.getThreadRecords.mockImplementationOnce(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(harness.projection())),
    );
    const holder = yield* withWorkspaceLease(worktreePath, Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(readEntered);
    expect(harness.getTurnStartContext).not.toHaveBeenCalled();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(startup);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

// regression: #15784 superseded provider startups kept running
effectIt.effect.each([
  { boundary: "policy resolution", loss: "replaced" },
  { boundary: "session opening", loss: "interrupted" },
])("does not continue startup when $loss during $boundary", ({ boundary, loss }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const projection = harness.projection();
    const providerThread = projection.providerThreads[0]!;
    const ensureThread = vi.fn(() => Effect.succeed(providerThread));
    const resumeThread = vi.fn(() => Effect.succeed(providerThread));
    const forkThread = vi.fn(() => Effect.succeed(providerThread));
    harness.open.mockReturnValue(
      (boundary === "session opening" ? gate : Effect.void).pipe(
        Effect.as({
          driver: providerThread.driver,
          ensureThread,
          resumeThread,
          forkThread,
        } as never),
      ),
    );
    if (boundary === "policy resolution") {
      harness.resolveRuntimePolicy.mockReturnValue(
        gate.pipe(Effect.as({ cwd: "/tmp/native-account-command" } as never)),
      );
    }

    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const current = harness.projection();
    const replacementId = RunAttemptId.make("replacement-attempt");
    const updated = {
      ...current,
      runs: current.runs.map((candidate) =>
        loss === "replaced"
          ? { ...candidate, activeAttemptId: replacementId }
          : { ...candidate, status: "interrupted" as const, completedAt: current.updatedAt },
      ),
      attempts:
        loss === "replaced"
          ? [...current.attempts, { ...current.attempts[0]!, id: replacementId, attemptOrdinal: 2 }]
          : current.attempts,
    };
    harness.setProjection(updated);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(startup);

    expect(harness.open).toHaveBeenCalledTimes(boundary === "session opening" ? 1 : 0);
    expect(ensureThread).not.toHaveBeenCalled();
    expect(resumeThread).not.toHaveBeenCalled();
    expect(forkThread).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.projection()).toEqual(updated);
  }),
);

effectIt.effect("starts another provider in the same checkout while a turn is pending", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-shared-checkout";
    const turnEntered = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const first = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const second = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    first.startRootRun.mockImplementation(() =>
      Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn))),
    );
    const pending = yield* first.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(turnEntered);
    yield* second.start;
    expect(second.startRootRun).toHaveBeenCalledOnce();
    expect(second.projection().runs.at(-1)?.status).toBe("running");
    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(pending);
  }),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(harness.settledRuns).toEqual(["failed"]);
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("fails the run without a retry when the provider needs sign-in", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: ProviderDriverKind.make("antigravity"),
        providerSessionId: ProviderSessionId.make("new-provider-session"),
        requiresSignIn: true,
      }),
    });

    yield* harness.startWithRetry;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "Failed to open antigravity provider session new-provider-session.",
        },
      },
    ]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(harness.settledRuns).toEqual([]);
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails the run instead of replacing a native thread another client holds", () =>
  Effect.gen(function* () {
    const detail = "This conversation is open in another Codex client.";
    const harness = makeLocalCommandHarness({
      text: "Continue",
      resumeFailure: new ProviderAdapter.ProviderAdapterThreadInUseError({
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: ProviderThreadId.make("new-provider-thread"),
        detail,
        cause: new Error("thread native-resume-thread already has an active writer"),
      }),
    });

    const exit = yield* Effect.exit(harness.start);

    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
    expect(exit._tag).toBe("Success");
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.providerThreads.at(-1)?.nativeThreadRef?.nativeId).toBe(
      "native-resume-thread",
    );
    expect(projection.contextHandoffs).toEqual([]);
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: { class: "provider_error", message: detail },
      },
    ]);
  }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

effectIt.effect.each(["superseded", "stopped", "account failover"] as const)(
  "does not start a provider after selected knowledge resolves for a %s attempt",
  (state) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("project-knowledge"),
        label: "Project knowledge",
        knowledge: {
          environmentId: EnvironmentId.make("test"),
          projectId: ProjectId.make("project-native-account-command"),
          selections: [{ kind: "fact" as const, factId: ProjectFactId.make("fact"), revision: 1 }],
          maxBytes: 48000,
        },
      };
      const harness = makeLocalCommandHarness({
        text: `Explain ${formatComposerContextReference(record)}`,
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
        resolveKnowledge: (context) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { context, text: "canonical knowledge", byteLength: 19 };
          }),
      });
      const projection = harness.projection();
      harness.setProjection({
        ...projection,
        messages: projection.messages.map((message) => ({
          ...message,
          context: { version: 1, records: [record] },
        })),
      });
      const fiber = yield* harness.start.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const current = harness.projection();
      harness.setProjection({
        ...current,
        runs: current.runs.map((run) => ({
          ...run,
          ...(state === "stopped"
            ? { status: "interrupted" as const }
            : { activeAttemptId: RunAttemptId.make("replacement") }),
        })),
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(harness.startRootRun).not.toHaveBeenCalled();
    }),
);

effectIt.effect.each([false, true])(
  "rehydrates selected knowledge at native delivery, stale=%s",
  (stale) =>
    Effect.gen(function* () {
      let resolved = 0;
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("project-knowledge"),
        label: "Project knowledge",
        knowledge: {
          environmentId: EnvironmentId.make("test"),
          projectId: ProjectId.make("project-native-account-command"),
          selections: [{ kind: "fact" as const, factId: ProjectFactId.make("fact"), revision: 1 }],
          maxBytes: 48000,
        },
      };
      const harness = makeLocalCommandHarness({
        text: `Preserve my question. ${formatComposerContextReference(record)}`,
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
        resolveKnowledge: (context) =>
          Effect.suspend(() => {
            resolved += 1;
            return stale && resolved > 1
              ? Effect.fail(
                  new ProjectKnowledgeError({
                    reason: "stale_context",
                    projectId: context.projectId,
                  }),
                )
              : Effect.succeed({ context, text: "Quoted </context> content.", byteLength: 26 });
          }),
      });
      const projection = harness.projection();
      harness.setProjection({
        ...projection,
        messages: projection.messages.map((message) => ({
          ...message,
          context: { version: 1, records: [record] },
        })),
      });
      yield* harness.start;
      const start = harness.startRootRun.mock.calls[0]![0];
      const result = yield* start.session
        .startTurn({
          appThread: start.appThread,
          threadId: start.appThread.id,
          runId: start.run.id,
          runOrdinal: start.run.ordinal,
          providerTurnOrdinal: start.providerTurnOrdinal,
          attemptId: start.attemptId,
          rootNodeId: start.rootNode.id,
          providerThread: start.providerThread,
          message: start.message,
          modelSelection: start.modelSelection,
          runtimePolicy: start.runtimePolicy,
        })
        .pipe(Effect.result);
      expect(resolved).toBe(2);
      if (stale) {
        expect(result._tag).toBe("Failure");
        expect(harness.nativeStart).not.toHaveBeenCalled();
        expect(harness.knowledgeDeliveries.at(-1)?.omissions[0]?.reason).toBe("stale_revision");
      } else {
        expect(
          harness.knowledgeDeliveries.map((delivery) => [
            delivery.attemptId,
            delivery.status,
            delivery.items,
          ]),
        ).toEqual(
          ["prepared", "sent"].map((status) => [
            harness.attemptId,
            status,
            [
              {
                contextId: record.contextId,
                label: record.label,
                context: record.knowledge,
                text: "Quoted </context> content.",
              },
            ],
          ]),
        );
        expect(result._tag).toBe("Success");
        expect(harness.knowledgeDeliveries.at(-1)?.providerThreadId).toBe(
          harness.projection().providerThreads[0]?.id,
        );
        expect(harness.knowledgeDeliveries.at(-1)?.nativeThreadId).toBe(
          harness.projection().providerThreads[0]?.nativeThreadRef?.nativeId,
        );
        yield* harness.start;
        expect(harness.nativeStart).toHaveBeenCalledOnce();
        yield* start.session.startTurn({
          appThread: start.appThread,
          threadId: start.appThread.id,
          runId: start.run.id,
          runOrdinal: start.run.ordinal,
          providerTurnOrdinal: start.providerTurnOrdinal,
          attemptId: start.attemptId,
          rootNodeId: start.rootNode.id,
          providerThread: start.providerThread,
          message: start.message,
          modelSelection: start.modelSelection,
          runtimePolicy: start.runtimePolicy,
        });
        expect(harness.nativeStart).toHaveBeenCalledOnce();
        expect(harness.nativeStart.mock.calls[0]?.[0].message.text).toContain(
          "Preserve my question.",
        );
        expect(harness.nativeStart.mock.calls[0]?.[0].message.text).toContain(
          "Quoted &lt;/context> content.",
        );
      }
    }),
);

const knowledgeRetryHarness = (
  options: {
    knowledgeStore?: Effect.Success<typeof KnowledgePersistence.makeStore>;
    initialDeliveries?: ReadonlyArray<ProjectKnowledgeDelivery>;
    recoveryNativeId?: string;
    modelContextWindow?: number;
    evidenceText?: string;
  } = {},
) => {
  const record = {
    version: 1 as const,
    kind: "project-knowledge" as const,
    contextId: ComposerContextId.make("retry-knowledge"),
    label: "Evidence",
    knowledge: {
      environmentId: EnvironmentId.make("test"),
      projectId: ProjectId.make("project-native-account-command"),
      selections: [{ kind: "fact" as const, factId: ProjectFactId.make("fact"), revision: 1 }],
      maxBytes: 48000,
    },
  };
  const harness = makeLocalCommandHarness({
    ...options,
    text: formatComposerContextReference(record),
    previousTurn: { runStatus: "completed", turnStatus: "completed" },
    resolveKnowledge: (context) => {
      const text = options.evidenceText ?? "Evidence";
      return Effect.succeed({ context, text, byteLength: Buffer.byteLength(text) });
    },
  });
  const projection = harness.projection();
  harness.setProjection({
    ...projection,
    messages: projection.messages.map((message) => ({
      ...message,
      context: { version: 1, records: [record] },
    })),
  });
  return harness;
};

const dispatchKnowledge = (start: RunExecutionService.RunExecutionServiceV2StartRootRunInput) =>
  start.session.startTurn({
    appThread: start.appThread,
    threadId: start.appThread.id,
    runId: start.run.id,
    runOrdinal: start.run.ordinal,
    providerTurnOrdinal: start.providerTurnOrdinal,
    attemptId: start.attemptId,
    rootNodeId: start.rootNode.id,
    providerThread: start.providerThread,
    message: start.message,
    modelSelection: start.modelSelection,
    runtimePolicy: start.runtimePolicy,
  });

effectIt.effect("reserves accepted knowledge before another turn without native telemetry", () =>
  Effect.gen(function* () {
    const store = yield* KnowledgePersistence.makeStore;
    const first = knowledgeRetryHarness({
      knowledgeStore: store,
      modelContextWindow: 200_000,
      evidenceText: "e".repeat(14_000),
    });
    const projection = first.projection();
    const originalMessageId = MessageId.make("earlier-knowledge-message");
    first.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, userMessageId: originalMessageId })),
      messages: projection.messages.map((message) => ({ ...message, id: originalMessageId })),
    });
    yield* first.start;
    yield* dispatchKnowledge(first.startRootRun.mock.calls[0]![0]);
    const original = (yield* store.deliveries(
      projection.thread.projectId,
      projection.thread.id,
      originalMessageId,
    ))[0]!;
    // Cursor exposes a 200k window without turn usage. Ten earlier accepted
    // attachments must consume the same fallback budget as their canonical text.
    for (let index = 1; index < 10; index++) {
      yield* store.recordDelivery({
        ...original,
        attemptId: RunAttemptId.make(`earlier-knowledge-attempt-${index}`),
        runId: RunId.make(`earlier-knowledge-run-${index}`),
        messageId: MessageId.make(`earlier-knowledge-message-${index}`),
      });
    }
    const next = knowledgeRetryHarness({
      knowledgeStore: store,
      modelContextWindow: 200_000,
      evidenceText: "e".repeat(14_000),
    });
    yield* next.start.pipe(Effect.result);
    expect(next.startRootRun).not.toHaveBeenCalled();
    const rejected = (yield* store.deliveries(
      projection.thread.projectId,
      projection.thread.id,
      next.projection().messages[0]!.id,
    ))[0]!;
    expect(rejected.status).toBe("failed");
    expect(rejected.omissions[0]?.reason).toBe("over_budget");
    expect(rejected.budget?.occupancy).toBeGreaterThan(140_000);
    expect(rejected.budget!.knowledgeAllowance).toBeLessThan(10_000);

    const retry = knowledgeRetryHarness({
      knowledgeStore: store,
      modelContextWindow: 200_000,
      evidenceText: "e".repeat(14_000),
    });
    const retryProjection = retry.projection();
    const retryAttemptId = RunAttemptId.make("same-native-knowledge-retry");
    retry.setProjection({
      ...retryProjection,
      runs: retryProjection.runs.map((run) =>
        run.activeAttemptId === retry.attemptId
          ? { ...run, userMessageId: originalMessageId, activeAttemptId: retryAttemptId }
          : run,
      ),
      attempts: retryProjection.attempts.map((attempt) =>
        attempt.id === retry.attemptId ? { ...attempt, id: retryAttemptId } : attempt,
      ),
      messages: retryProjection.messages.map((message) => ({ ...message, id: originalMessageId })),
    });
    const occupied = yield* store.nativeDeliveryEstimate(original);
    yield* retry.start;
    yield* dispatchKnowledge(retry.startRootRun.mock.calls[0]![0]);
    expect(retry.nativeStart).toHaveBeenCalledOnce();
    expect(retry.nativeStart.mock.calls[0]![0].message.text).not.toContain("e".repeat(100));
    const receipts = yield* store.deliveries(
      projection.thread.projectId,
      projection.thread.id,
      originalMessageId,
    );
    const suppressed = receipts.find((receipt) => receipt.attemptId === retryAttemptId)!;
    expect(suppressed.status).toBe("sent");
    expect(suppressed.items).toEqual([]);
    expect(suppressed.budget?.estimatedTokens).toBe(0);
    expect(receipts.find((receipt) => receipt.attemptId === original.attemptId)).toEqual(original);
    expect(yield* store.nativeDeliveryEstimate(original)).toBe(occupied);
  }).pipe(
    Effect.provide(SqlitePersistence.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

effectIt.effect(
  "same-attempt retry does not resend knowledge to the same native conversation",
  () =>
    Effect.gen(function* () {
      const harness = knowledgeRetryHarness();
      yield* harness.start;
      const start = harness.startRootRun.mock.calls[0]![0];
      yield* dispatchKnowledge(start);
      yield* dispatchKnowledge(start);
      expect(harness.nativeStart).toHaveBeenCalledOnce();
    }),
);

effectIt.effect(
  "lost acknowledgement leaves uncertain knowledge and refuses blind same-conversation retry",
  () =>
    Effect.gen(function* () {
      const harness = knowledgeRetryHarness();
      harness.nativeStart.mockImplementationOnce((request) =>
        Effect.gen(function* () {
          expect(request.message.text).toContain("Evidence");
          return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
            driver: request.providerThread.driver,
            threadId: request.threadId,
            providerThreadId: request.providerThread.id,
            runId: request.runId,
            cause: "lost injection acknowledgement",
          });
        }),
      );
      yield* harness.start;
      const start = harness.startRootRun.mock.calls[0]![0];
      expect((yield* dispatchKnowledge(start).pipe(Effect.result))._tag).toBe("Failure");
      expect(harness.knowledgeDeliveries.at(-1)?.status).toBe("uncertain");
      expect((yield* dispatchKnowledge(start).pipe(Effect.result))._tag).toBe("Failure");
      expect(harness.nativeStart).toHaveBeenCalledOnce();
    }),
);

effectIt.effect(
  "replacement native conversation receives knowledge once while the old receipt stays bound",
  () =>
    Effect.gen(function* () {
      const old = knowledgeRetryHarness();
      yield* old.start;
      yield* dispatchKnowledge(old.startRootRun.mock.calls[0]![0]);
      const receipt = old.knowledgeDeliveries.at(-1)!;
      const replacement = knowledgeRetryHarness({
        initialDeliveries: [{ ...receipt, attemptId: RunAttemptId.make("old-attempt") }],
        recoveryNativeId: "replacement-native-conversation",
      });
      const projection = replacement.projection();
      replacement.setProjection({
        ...projection,
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          nativeThreadRef: {
            driver: thread.driver,
            nativeId: "replacement-native-conversation",
            strength: "strong",
          },
        })),
      });
      yield* replacement.start;
      const start = replacement.startRootRun.mock.calls[0]![0];
      yield* dispatchKnowledge(start);
      yield* dispatchKnowledge(start);
      expect(replacement.nativeStart).toHaveBeenCalledOnce();
      expect(replacement.nativeStart.mock.calls[0]![0].message.text).toContain("Evidence");
      expect(replacement.knowledgeDeliveries[0]?.nativeThreadId).toBe(
        "existing-native-conversation",
      );
      expect(replacement.knowledgeDeliveries.at(-1)?.nativeThreadId).toBe(
        "replacement-native-conversation",
      );
      expect(replacement.knowledgeDeliveries.at(-1)?.status).toBe("sent");
    }),
);

effectIt.effect.each(["prepared", "uncertain"] as const)(
  "recovers a %s knowledge receipt through the native handoff fallback without resuming the ambiguous conversation",
  (status) =>
    Effect.gen(function* () {
      const old = knowledgeRetryHarness();
      yield* old.start;
      yield* dispatchKnowledge(old.startRootRun.mock.calls[0]![0]);
      const receipt = old.knowledgeDeliveries.at(-1)!;
      const recovery = knowledgeRetryHarness({
        initialDeliveries: [{ ...receipt, attemptId: RunAttemptId.make("old-attempt"), status }],
        recoveryNativeId: "fresh-native-conversation",
      });
      yield* recovery.start;
      expect(recovery.events.some((event) => event.type === "context-handoff.updated")).toBe(true);
      expect(recovery.events.some((event) => event.type === "context-transfer.updated")).toBe(true);
      expect(recovery.knowledgeDeliveries.at(-1)?.status).toBe("uncertain");
      const start = recovery.startRootRun.mock.calls[0]![0];
      yield* dispatchKnowledge(start);
      yield* dispatchKnowledge(start);
      expect(recovery.nativeStart).toHaveBeenCalledOnce();
      expect(recovery.nativeStart.mock.calls[0]![0].message.text).toContain("Evidence");
      expect(recovery.knowledgeDeliveries[0]?.nativeThreadId).toBe("existing-native-conversation");
      expect(recovery.knowledgeDeliveries.at(-1)?.nativeThreadId).toBe("fresh-native-conversation");
    }),
);

effectIt.effect.each(["current", "legacy"] as const)(
  "recovers a %s prepared native delivery omitted by the inspector receipt page",
  (identity) =>
    Effect.gen(function* () {
      const old = knowledgeRetryHarness();
      yield* old.start;
      yield* dispatchKnowledge(old.startRootRun.mock.calls[0]![0]);
      const original = old.knowledgeDeliveries.at(-1)!;
      const { providerThreadId: _destination, ...legacy } = original;
      const receipt = identity === "legacy" ? { ...legacy, nativeThreadId: null } : original;
      const store = yield* KnowledgePersistence.makeStore;
      for (let index = 0; index < 25; index++)
        yield* store.recordDelivery({
          ...receipt,
          attemptId: RunAttemptId.make(`older-delivery-${index}`),
          status: "failed",
          createdAt: "1900-01-01T00:00:00.000Z",
          updatedAt: "1900-01-01T00:00:00.000Z",
        });
      yield* store.recordDelivery({ ...receipt, status: "prepared" });
      const page = yield* store.deliveries(receipt.projectId, receipt.threadId, receipt.messageId);
      expect(page).toHaveLength(20);
      expect(page.every((row) => row.status === "failed")).toBe(true);
      const recovery = knowledgeRetryHarness({
        knowledgeStore: store,
        recoveryNativeId: "fresh-after-paged-receipts",
      });
      yield* recovery.start;
      expect(recovery.events.some((event) => event.type === "context-handoff.updated")).toBe(true);
      const sql = yield* SqlClient.SqlClient;
      const [recovered] = yield* sql<{
        status: string;
      }>`SELECT status FROM project_knowledge_deliveries
      WHERE attempt_id = ${receipt.attemptId} AND message_id = ${receipt.messageId}`;
      expect(recovered?.status).toBe("uncertain");
      const start = recovery.startRootRun.mock.calls[0]![0];
      yield* dispatchKnowledge(start);
      yield* dispatchKnowledge(start);
      expect(recovery.nativeStart).toHaveBeenCalledOnce();
      expect(
        (yield* store.readDeliveryState({
          ...original,
          nativeThreadId: "fresh-after-paged-receipts",
          scope: "native-conversation",
        })).sentThisAttempt,
      ).toBe(true);
    }).pipe(
      Effect.provide(SqlitePersistence.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

effectIt.effect(
  "SQLite restart mid-delivery recovers prepared knowledge onto a fresh native handoff exactly once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = () =>
        SqlitePersistence.layerFromPath(directory + "/knowledge.sqlite").pipe(
          Layer.provide(NodeServices.layer),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* KnowledgePersistence.makeStore;
          const harness = knowledgeRetryHarness({ knowledgeStore: store });
          harness.nativeStart.mockImplementationOnce(() => Effect.interrupt);
          yield* harness.start;
          const start = harness.startRootRun.mock.calls[0]![0];
          yield* dispatchKnowledge(start).pipe(Effect.exit);
          const receipts = yield* store.deliveries(
            start.appThread.projectId,
            start.appThread.id,
            MessageId.make("message-native-account-command"),
          );
          expect(receipts[0]?.status).toBe("prepared");
        }).pipe(Effect.provide(database())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* KnowledgePersistence.makeStore;
          const harness = knowledgeRetryHarness({
            knowledgeStore: store,
            recoveryNativeId: "restarted-native-conversation",
          });
          yield* harness.start;
          const start = harness.startRootRun.mock.calls[0]![0];
          const receipts = yield* store.deliveries(
            start.appThread.projectId,
            start.appThread.id,
            MessageId.make("message-native-account-command"),
          );
          expect(receipts[0]?.status).toBe("uncertain");
          expect(receipts[0]?.nativeThreadId).toBe("existing-native-conversation");
          expect(harness.events.some((event) => event.type === "context-handoff.updated")).toBe(
            true,
          );
          yield* dispatchKnowledge(start);
          yield* dispatchKnowledge(start);
          expect(harness.nativeStart).toHaveBeenCalledOnce();
          expect(harness.nativeStart.mock.calls[0]![0].message.text).toContain("Evidence");
          const delivered = yield* store.deliveries(
            start.appThread.projectId,
            start.appThread.id,
            MessageId.make("message-native-account-command"),
          );
          expect(delivered[0]?.status).toBe("sent");
          expect(delivered[0]?.nativeThreadId).toBe("restarted-native-conversation");
        }).pipe(Effect.provide(database())),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("records a delivery receipt when every attached knowledge record is omitted", () =>
  Effect.gen(function* () {
    const record = {
      version: 1 as const,
      kind: "project-knowledge" as const,
      contextId: ComposerContextId.make("project-knowledge"),
      label: "Project knowledge",
      knowledge: {
        environmentId: EnvironmentId.make("test"),
        projectId: ProjectId.make("project-native-account-command"),
        selections: [{ kind: "fact" as const, factId: ProjectFactId.make("fact"), revision: 1 }],
        maxBytes: 48000,
      },
    };
    const harness = makeLocalCommandHarness({
      text: "The reference token was deleted from this message.",
      previousTurn: { runStatus: "completed", turnStatus: "completed" },
    });
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      messages: projection.messages.map((message) => ({
        ...message,
        context: { version: 1, records: [record] },
      })),
    });
    yield* harness.start;
    const start = harness.startRootRun.mock.calls[0]![0];
    yield* start.session.startTurn({
      appThread: start.appThread,
      threadId: start.appThread.id,
      runId: start.run.id,
      runOrdinal: start.run.ordinal,
      providerTurnOrdinal: start.providerTurnOrdinal,
      attemptId: start.attemptId,
      rootNodeId: start.rootNode.id,
      providerThread: start.providerThread,
      message: start.message,
      modelSelection: start.modelSelection,
      runtimePolicy: start.runtimePolicy,
    });
    expect(
      harness.knowledgeDeliveries.map((delivery) => [
        delivery.status,
        delivery.items,
        delivery.omissions,
      ]),
    ).toEqual(
      ["prepared", "sent"].map((status) => [
        status,
        [],
        [{ contextId: record.contextId, label: record.label, reason: "not_referenced" }],
      ]),
    );
  }),
);

effectIt.effect(
  "replays the knowledge an earlier message was sent with into a provider handoff once",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-native-account-command");
      const sourceRunId = RunId.make("run-knowledge-source");
      const sourceMessageId = MessageId.make("message-knowledge-source");
      const requestedRuns: Array<ReadonlyArray<RunId>> = [];
      const harness = makeLocalCommandHarness({
        text: "Continue on the new provider",
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
        // The fact was edited after the earlier message was sent; the handoff must not re-hydrate.
        resolveKnowledge: (context) =>
          Effect.succeed({ context, text: "EDITED fact text", byteLength: 16 }),
        readSentDeliveries: (input) =>
          Effect.sync(() => {
            requestedRuns.push(input.runIds);
            return [
              {
                attemptId: RunAttemptId.make("attempt-knowledge-source"),
                runId: sourceRunId,
                threadId: harness.projection().thread.id,
                messageId: sourceMessageId,
                projectId,
                providerInstanceId: harness.oldInstanceId,
                status: "sent" as const,
                items: [
                  {
                    contextId: "project-knowledge",
                    label: "Deploy rule",
                    context: {
                      environmentId: EnvironmentId.make("test"),
                      projectId,
                      selections: [
                        { kind: "fact" as const, factId: ProjectFactId.make("fact"), revision: 1 },
                      ],
                      maxBytes: 48000,
                    },
                    text: "ORIGINAL fact text",
                  },
                ],
                omissions: [],
                createdAt: "2026-09-04T11:00:00.000Z",
                updatedAt: "2026-09-04T11:00:00.000Z",
              },
            ];
          }),
      });
      const projection = harness.projection();
      const run = projection.runs.at(-1)!;
      const historical = (
        id: string,
        role: "user" | "assistant",
        text: string,
      ): OrchestrationV2HistoricalMessage => ({
        itemId: TurnItemId.make(id),
        role,
        text,
        threadId: projection.thread.id,
        runId: sourceRunId,
        providerThreadId: ProviderThreadId.make("existing-native-provider-thread"),
        status: "completed",
        kind: role === "user" ? "user_message" : "assistant_message",
      });
      const handoff: OrchestrationV2ContextHandoff = {
        id: ContextHandoffId.make("handoff-provider-switch"),
        transferId: null,
        threadId: projection.thread.id,
        targetRunId: run.id,
        fromProviderThreadIds: [ProviderThreadId.make("existing-native-provider-thread")],
        toProviderThreadId: run.providerThreadId!,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary",
        status: "ready",
        summaryMessageId: null,
        summaryText: "",
        history: {
          messages: [
            historical(
              IdAllocator.derive.userTurnItem({ messageId: sourceMessageId }),
              "user",
              "Follow the deploy rule",
            ),
            historical("turn-item-knowledge-answer", "assistant", "Done"),
          ],
          coverage: "Provider context handoff.",
          omittedItems: 0,
          omittedItemIds: [],
        },
        createdByProviderInstanceId: null,
        createdAt: run.requestedAt,
        updatedAt: run.requestedAt,
      };
      harness.setProjection({ ...projection, contextHandoffs: [handoff] });

      const startNativeTurn = Effect.gen(function* () {
        yield* harness.start;
        const start = harness.startRootRun.mock.calls.at(-1)![0];
        yield* start.session.startTurn({
          appThread: start.appThread,
          threadId: start.appThread.id,
          runId: start.run.id,
          runOrdinal: start.run.ordinal,
          providerTurnOrdinal: start.providerTurnOrdinal,
          attemptId: start.attemptId,
          rootNodeId: start.rootNode.id,
          providerThread: start.providerThread,
          message: start.message,
          modelSelection: start.modelSelection,
          runtimePolicy: start.runtimePolicy,
        });
        return harness.nativeStart.mock.calls.at(-1)![0].message.text;
      });

      const sent = yield* startNativeTurn;
      expect(requestedRuns).toEqual([[sourceRunId]]);
      expect(sent.split("ORIGINAL fact text")).toHaveLength(2);
      expect(sent).toContain('<t3_delivered_knowledge label="Deploy rule">');
      expect(sent).toContain("reproduced as sent");
      expect(sent).not.toContain("EDITED fact text");
      expect(sent.indexOf("Follow the deploy rule")).toBeLessThan(sent.indexOf("ORIGINAL"));
      expect(harness.projection().contextHandoffs[0]?.delivery?.status).toBe("inline");
      // The persisted handoff keeps the message as authored; the excerpt lives in its delivery record.
      expect(harness.projection().contextHandoffs[0]?.history?.messages[0]?.text).toBe(
        "Follow the deploy rule",
      );

      // A retried start of the same attempt reaches the native conversation that already has it.
      const current = harness.projection();
      harness.setProjection({
        ...current,
        runs: current.runs.map((candidate) =>
          candidate.id === run.id ? { ...candidate, status: "starting" } : candidate,
        ),
      });
      const retried = yield* startNativeTurn;
      expect(harness.nativeStart).toHaveBeenCalledTimes(2);
      expect(retried).not.toContain("ORIGINAL fact text");
      expect(retried).toContain("Continue on the new provider");
    }),
);
effectIt.effect("records optional recall failure while starting the provider turn", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-native-account-command");
    const sourceRunId = RunId.make("run-knowledge-source");
    const sourceMessageId = MessageId.make("message-knowledge-source");

    const harness = makeLocalCommandHarness({
      text: "Continue on the new provider",
      previousTurn: { runStatus: "completed", turnStatus: "completed" },
      // The fact was edited after the earlier message was sent; the handoff must not re-hydrate.
      resolveKnowledge: (context) =>
        Effect.succeed({ context, text: "EDITED fact text", byteLength: 16 }),
      readSentDeliveries: () =>
        Effect.fail(new ProjectKnowledgeError({ reason: "storage", projectId })),
    });
    const projection = harness.projection();
    const run = projection.runs.at(-1)!;
    const historical = (
      id: string,
      role: "user" | "assistant",
      text: string,
    ): OrchestrationV2HistoricalMessage => ({
      itemId: TurnItemId.make(id),
      role,
      text,
      threadId: projection.thread.id,
      runId: sourceRunId,
      providerThreadId: ProviderThreadId.make("existing-native-provider-thread"),
      status: "completed",
      kind: role === "user" ? "user_message" : "assistant_message",
    });
    const handoff: OrchestrationV2ContextHandoff = {
      id: ContextHandoffId.make("handoff-provider-switch"),
      transferId: null,
      threadId: projection.thread.id,
      targetRunId: run.id,
      fromProviderThreadIds: [ProviderThreadId.make("existing-native-provider-thread")],
      toProviderThreadId: run.providerThreadId!,
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary",
      status: "ready",
      summaryMessageId: null,
      summaryText: "",
      history: {
        messages: [
          historical(
            IdAllocator.derive.userTurnItem({ messageId: sourceMessageId }),
            "user",
            "Follow the deploy rule",
          ),
          historical("turn-item-knowledge-answer", "assistant", "Done"),
        ],
        coverage: "Provider context handoff.",
        omittedItems: 0,
        omittedItemIds: [],
      },
      createdByProviderInstanceId: null,
      createdAt: run.requestedAt,
      updatedAt: run.requestedAt,
    };
    harness.setProjection({ ...projection, contextHandoffs: [handoff] });

    const startNativeTurn = Effect.gen(function* () {
      yield* harness.start;
      const start = harness.startRootRun.mock.calls.at(-1)![0];
      yield* start.session.startTurn({
        appThread: start.appThread,
        threadId: start.appThread.id,
        runId: start.run.id,
        runOrdinal: start.run.ordinal,
        providerTurnOrdinal: start.providerTurnOrdinal,
        attemptId: start.attemptId,
        rootNodeId: start.rootNode.id,
        providerThread: start.providerThread,
        message: start.message,
        modelSelection: start.modelSelection,
        runtimePolicy: start.runtimePolicy,
      });
      return harness.nativeStart.mock.calls.at(-1)![0].message.text;
    });

    yield* startNativeTurn;
    expect(harness.nativeStart).toHaveBeenCalled();
    expect(
      harness.knowledgeDeliveries.at(-1)?.omissions.some((item) => item.reason === "recall_failed"),
    ).toBe(true);
    expect(harness.knowledgeDeliveries.at(-1)?.status).toBe("sent");
  }),
);

effectIt.effect("records an over-budget mandatory attachment without starting the provider", () =>
  Effect.gen(function* () {
    const harness = knowledgeRetryHarness();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      messages: projection.messages.map((message) => ({
        ...message,
        context: {
          version: 1,
          records: (message.context?.records ?? []).map((record) =>
            record.kind === "project-knowledge" && "knowledge" in record
              ? { ...record, knowledge: { ...record.knowledge, maxBytes: 1 } }
              : record,
          ),
        },
      })),
    });
    yield* harness.start.pipe(Effect.result);
    expect(harness.nativeStart).not.toHaveBeenCalled();
    expect(harness.knowledgeDeliveries.at(-1)?.omissions[0]?.reason).toBe("over_budget");
  }),
);

effectIt.effect.each([
  true,
  false,
  "agent-authored",
  "notification",
  "delegated-completion",
  "scheduled",
  "project-disabled",
  "pack-failure",
] as const)("start delivers bundled pstack records before native projection, enabled=%s", (mode) =>
  Effect.gen(function* () {
    const enabled = mode !== false;
    const authoredByUser = mode !== "agent-authored";
    const fixture = yield* makeFixture([claudeProvider]);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${fixture.stateDir}/pstack`, { recursive: true });
    yield* fs.writeFileString(
      `${fixture.stateDir}/pstack/models.md`,
      "architect runners: claudeAgent/claude-opus-5-5 effort=xhigh fastMode=false",
    );
    if (mode === "pack-failure") yield* fs.remove(fixture.sourceRoot, { recursive: true });
    yield* Effect.gen(function* () {
      const pstack = yield* PstackPack.PstackPack;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ pstackEnabled: enabled });
      const record = {
        version: 1 as const,
        kind: "skill" as const,
        contextId: ComposerContextId.make("pstack-start"),
        name: "pstack:architect",
        label: "architect",
      };
      const native = {
        ...record,
        contextId: ComposerContextId.make("native-start"),
        name: "native:review",
        label: "review",
      };
      const harness = makeLocalCommandHarness({
        text: `Result mentions $pstack:architect then ${formatComposerContextReference(record)} plan ${formatComposerContextReference(native)}`,
        pstack,
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
      });
      const projection = harness.projection();
      if (mode === "project-disabled")
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projection.thread.projectId]: {
              providerInstances: { [claudeProvider.instanceId]: { enabled: false } },
            },
          },
        });
      harness.setProjection({
        ...projection,
        messages: projection.messages.map((message) => ({
          ...message,
          ...(mode === "scheduled"
            ? { scheduledTaskId: ScheduledTaskId.make("pstack-saved-prompt") }
            : {}),
          ...(mode === "notification"
            ? {
                notification: {
                  source: { kind: "command" as const },
                  outcome: "completed" as const,
                  summary: "Task finished",
                },
              }
            : {}),
          ...(mode === "delegated-completion"
            ? {
                delegatedCompletion: {
                  parentRunId: RunId.make("parent"),
                  generation: 1,
                  taskIds: [NodeId.make("child")],
                },
              }
            : {}),
          createdBy: authoredByUser ? "user" : "agent",
          creationSource: authoredByUser ? "web" : "server",
          context: { version: 1, records: [record, native] },
        })),
      });
      yield* harness.start;
      const start = harness.startRootRun.mock.calls[0]![0];
      yield* start.session.startTurn({
        appThread: start.appThread,
        threadId: start.appThread.id,
        runId: start.run.id,
        runOrdinal: start.run.ordinal,
        providerTurnOrdinal: start.providerTurnOrdinal,
        attemptId: start.attemptId,
        rootNodeId: start.rootNode.id,
        providerThread: start.providerThread,
        message: start.message,
        modelSelection: start.modelSelection,
        runtimePolicy: start.runtimePolicy,
      });
      const text = harness.nativeStart.mock.calls[0]![0].message.text;
      expect(text).toContain("native:review");
      if (mode === "pack-failure") {
        expect(text).toContain("pstack is unavailable:");
        expect(text).toContain("$pstack:architect");
        expect(text).not.toContain("<t3_pstack>");
      } else if (
        enabled &&
        authoredByUser &&
        mode !== "notification" &&
        mode !== "delegated-completion"
      ) {
        if (mode === "project-disabled")
          expect(text).toContain("Fallback: architect runners seat 1");
        else expect(text).not.toContain("Fallback:");
        expect(text).toContain("<t3_pstack>");
        expect(text).not.toContain("$pstack:architect");
      } else {
        expect(text).not.toContain("<t3_pstack>");
        expect(text).toContain("pstack:architect");
      }
    }).pipe(Effect.provide(Layer.merge(fixture.layer, fixture.settingsLayer)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
