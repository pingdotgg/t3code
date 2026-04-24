import type {
  ChatAttachment,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanStep,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS } from "../../provider/codex/CodexDeveloperInstructions.ts";
import {
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "../../provider/Layers/EventNdjsonLogger.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";

const CODEX_PROVIDER = "codex" as const;
const CODEX_CLIENT_INFO = {
  name: "t3code_desktop",
  title: "T3 Code Desktop",
  version: "0.1.0",
} as const;
const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
} as const;

export const CodexProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

function toProtocolError(detail: string, payload?: unknown): ProviderAdapterProtocolError {
  return new ProviderAdapterProtocolError({
    provider: CODEX_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

function normalizeCodexCause(error: unknown): unknown {
  return error;
}

function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
  return seconds === null || seconds === undefined
    ? DateTime.nowUnsafe()
    : DateTime.fromDateUnsafe(new Date(seconds * 1000));
}

function mapCodexTurnStatus(
  status: CodexSchema.V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "inProgress":
      return "running";
  }
}

function providerTurnStatusToTerminal(
  status: OrchestrationV2ProviderTurn["status"],
): Extract<ProviderAdapterV2Event, { type: "turn.terminal" }>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "running":
      return "failed";
  }
}

function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}

function codexNativeItemRef(nativeItemId: string) {
  return {
    provider: CODEX_PROVIDER,
    nativeId: nativeItemId,
    strength: "strong" as const,
  };
}

function trimText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyText(value: string | null | undefined, fallback: string): string {
  return trimText(value) ?? fallback;
}

function codexPlanStepStatus(
  status: CodexSchema.V2TurnPlanUpdatedNotification__TurnPlanStepStatus,
): OrchestrationV2PlanStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
      return "running";
    case "pending":
      return "pending";
  }
}

function approvalDecisionToLegacyReviewDecision(
  decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "decline":
      return "denied";
    case "cancel":
      return "abort";
  }
}

function providerRequestKindFromPermissions(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
  if ((permissions.fileSystem?.write?.length ?? 0) > 0) {
    return "file-change";
  }
  if ((permissions.fileSystem?.read?.length ?? 0) > 0) {
    return "file-read";
  }
  return "command";
}

function permissionsResponseFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
  if (input.decision !== "accept" && input.decision !== "acceptForSession") {
    return { permissions: {}, scope: "turn" };
  }

  return {
    permissions: input.permissions,
    scope: input.decision === "acceptForSession" ? "session" : "turn",
  };
}

function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      { answers: [...answerValueToStrings(value)] },
    ]),
  );
}

function compactStrings(values: ReadonlyArray<string | null | undefined>): ReadonlyArray<string> {
  return values.flatMap((value) => {
    const trimmed = trimText(value);
    return trimmed === undefined ? [] : [trimmed];
  });
}

function webSearchPatterns(item: CodexWebSearchItem): ReadonlyArray<string> {
  if (item.action === null || item.action === undefined) {
    return compactStrings([item.query]);
  }

  switch (item.action.type) {
    case "search":
      return compactStrings([...(item.action.queries ?? []), item.action.query, item.query]);
    case "openPage":
      return compactStrings([item.action.url, item.query]);
    case "findInPage":
      return compactStrings([item.action.pattern, item.action.url, item.query]);
    case "other":
      return compactStrings([item.query]);
  }
}

const decodeTurnApprovalPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__AskForApproval, Schema.Null]),
);
const decodeTurnSandboxPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__SandboxPolicy, Schema.Null]),
);
const decodeTurnReasoningEffort = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__ReasoningEffort, Schema.Null]),
);

const CodexTurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

function buildTurnStartParams(input: {
  readonly nativeThreadId: string;
  readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly model: string;
}) {
  return Effect.gen(function* () {
    const approvalPolicy =
      input.runtimePolicy.approvalPolicy === undefined
        ? undefined
        : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
    const sandboxPolicy =
      input.runtimePolicy.sandboxPolicy === undefined
        ? undefined
        : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
    const effort =
      input.runtimePolicy.reasoningEffort === undefined
        ? undefined
        : yield* decodeTurnReasoningEffort(input.runtimePolicy.reasoningEffort);
    const collaborationMode: CodexSchema.V2TurnStartParams__CollaborationMode | undefined =
      input.runtimePolicy.interactionMode === "plan"
        ? {
            mode: "plan",
            settings: {
              model: input.model,
              reasoning_effort: effort ?? "medium",
              developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
            },
          }
        : undefined;

    return yield* Schema.decodeUnknownEffect(CodexTurnStartParamsWithCollaborationMode)({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(effort === undefined ? {} : { effort }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    });
  });
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    provider: CODEX_PROVIDER,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function getNativeThreadId(providerThread: OrchestrationV2ProviderThread) {
  return Effect.gen(function* () {
    const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
    if (nativeThreadId === undefined || nativeThreadId === null) {
      return yield* toProtocolError(
        `Provider thread ${providerThread.id} is missing a native Codex thread id.`,
      );
    }
    return nativeThreadId;
  });
}

function providerThreadFromCodexThread(input: {
  readonly appThreadId: ThreadId | null;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly ownerNodeId: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly thread: {
    readonly createdAt: number;
    readonly forkedFromId?: string | null;
    readonly id: string;
    readonly updatedAt: number;
  };
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      provider: CODEX_PROVIDER,
      nativeThreadId: input.thread.id,
    }),
    provider: CODEX_PROVIDER,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: {
      provider: CODEX_PROVIDER,
      nativeId: input.thread.id,
      strength: "strong" as const,
    },
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: codexTimestamp(input.thread.createdAt),
    updatedAt: codexTimestamp(input.thread.updatedAt),
  };
}

interface ActiveCodexTurnContext {
  readonly input: ProviderAdapterV2TurnInput;
  readonly nativeTurnId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnOrdinal: number;
  readonly startedAt: DateTime.Utc;
}

type PendingCodexRuntimeRequest =
  | {
      readonly type: "approval";
      readonly requestId: RuntimeRequestId;
      readonly requestKind: ProviderRequestKind;
      readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
    }
  | {
      readonly type: "user_input";
      readonly requestId: RuntimeRequestId;
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers, never>;
    };

type CodexWebSearchItem = {
  readonly id: string;
  readonly type: "webSearch";
  readonly query?: string | null;
  readonly action?:
    | CodexSchema.V2ItemStartedNotification__WebSearchAction
    | CodexSchema.V2ItemCompletedNotification__WebSearchAction
    | null;
};

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  }) => Effect.Effect<
    CodexClient.CodexAppServerClientShape,
    ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/CodexAppServerClientFactory") {}

export const makeCodexAppServerClientFactoryCommandLayer = (
  options: CodexClient.CodexAppServerCommandLayerOptions,
): Layer.Layer<CodexAppServerClientFactory, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    CodexAppServerClientFactory,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return CodexAppServerClientFactory.of({
        open: (input) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const command = ChildProcess.make(options.command, [...(options.args ?? [])], {
              ...((input.runtimePolicy.cwd ?? options.cwd) === undefined
                ? {}
                : { cwd: input.runtimePolicy.cwd ?? options.cwd }),
              ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
              shell: process.platform === "win32",
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterOpenSessionError({
                    provider: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );
            const context = yield* Layer.build(CodexClient.layerChildProcess(handle, options));
            return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
          }),
      });
    }),
  );

export function makeCodexAppServerProtocolLogger(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CodexClient.CodexAppServerClientOptions["logger"] | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) =>
    nativeEventLogger
      .write(
        {
          provider: CODEX_PROVIDER,
          protocol: "codex.app-server",
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event,
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
}

export const codexAppServerClientFactoryFromSettingsLayer: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ServerConfig | ServerSettingsService
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { providerEventLogPath } = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });

    return CodexAppServerClientFactory.of({
      open: (input) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          yield* settingsService.ready.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  provider: CODEX_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const codexSettings = yield* settingsService.getSettings.pipe(
            Effect.map((settings) => settings.providers.codex),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  provider: CODEX_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const command = ChildProcess.make(codexSettings.binaryPath || "codex", ["app-server"], {
            ...(input.runtimePolicy.cwd === null ? {} : { cwd: input.runtimePolicy.cwd }),
            env: {
              ...process.env,
              ...(codexSettings.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
            },
            shell: process.platform === "win32",
          });
          const handle = yield* spawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  provider: CODEX_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const protocolLogger = makeCodexAppServerProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const clientOptions: CodexClient.CodexAppServerClientOptions =
            protocolLogger === undefined
              ? {}
              : {
                  logIncoming: true,
                  logOutgoing: true,
                  logger: protocolLogger,
                };
          const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
          return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
        }),
    });
  }),
);

export const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  CodexAppServerClientFactory | FileSystem.FileSystem | IdAllocatorV2 | ServerConfig
> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocatorV2;
    const serverConfig = yield* ServerConfig;

    return ProviderAdapterV2.of({
      provider: CODEX_PROVIDER,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      openSession: (input) =>
        Effect.gen(function* () {
          const client = yield* clientFactory.open({
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
            runtimePolicy: input.runtimePolicy,
          });
          const initialized = yield* Ref.make(false);
          const ensureInitialized = Effect.gen(function* () {
            const alreadyInitialized = yield* Ref.get(initialized);
            if (alreadyInitialized) {
              return;
            }

            yield* client.request("initialize", {
              clientInfo: CODEX_CLIENT_INFO,
              capabilities: CODEX_CLIENT_CAPABILITIES,
            });
            yield* client.notify("initialized", undefined);
            yield* Ref.set(initialized, true);
          });
          const now = yield* DateTime.now;
          const session = providerSession({
            providerSessionId: input.providerSessionId,
            cwd: input.runtimePolicy.cwd,
            model: input.modelSelection.model,
            now,
          });
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const activeTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());
          const turnWaiters = yield* Ref.make(new Map<string, Deferred.Deferred<void, never>>());
          const itemOrdinals = yield* Ref.make(new Map<string, number>());
          const nextItemOrdinalsByTurn = yield* Ref.make(new Map<string, number>());
          const agentMessageDeltas = yield* Ref.make(new Map<string, string>());
          const planDeltas = yield* Ref.make(new Map<string, string>());
          const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());
          const pendingRuntimeRequests = yield* Ref.make(
            new Map<string, PendingCodexRuntimeRequest>(),
          );

          const emitProviderEvent = (event: ProviderAdapterV2Event) =>
            Queue.offer(events, event).pipe(Effect.asVoid);

          const findActiveTurnByNativeThreadId = (nativeThreadId: string) =>
            Effect.gen(function* () {
              const turns = Array.from((yield* Ref.get(activeTurns)).values());
              return turns.find(
                (context) =>
                  context.input.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
              );
            });

          const resolveItemOrdinal = (context: ActiveCodexTurnContext, nativeItemId: string) =>
            Effect.gen(function* () {
              const existing = (yield* Ref.get(itemOrdinals)).get(nativeItemId);
              if (existing !== undefined) {
                return existing;
              }

              const turnKey = context.nativeTurnId;
              const nextWithinTurn = yield* Ref.modify(nextItemOrdinalsByTurn, (current) => {
                const next = (current.get(turnKey) ?? 0) + 1;
                const updated = new Map(current);
                updated.set(turnKey, next);
                return [next, updated];
              });
              const nextOrdinal = context.providerTurnOrdinal * 100 + nextWithinTurn;
              yield* Ref.update(itemOrdinals, (current) => {
                const updated = new Map(current);
                updated.set(nativeItemId, nextOrdinal);
                return updated;
              });
              return nextOrdinal;
            });

          const resolvePlanId = (context: ActiveCodexTurnContext, planKey: string) =>
            Effect.gen(function* () {
              const existing = (yield* Ref.get(planIds)).get(planKey);
              if (existing !== undefined) {
                return existing;
              }
              const planId = yield* idAllocator.allocate.plan({
                threadId: context.input.threadId,
                runId: context.input.runId,
                provider: CODEX_PROVIDER,
              });
              yield* Ref.update(planIds, (current) => {
                const updated = new Map(current);
                updated.set(planKey, planId);
                return updated;
              });
              return planId;
            });

          const resolveCodexAttachment = (attachment: ChatAttachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (attachmentPath === null) {
                return yield* toProtocolError(`Invalid attachment id '${attachment.id}'`);
              }
              const bytes = yield* fileSystem
                .readFile(attachmentPath)
                .pipe(
                  Effect.mapError((cause) =>
                    toProtocolError(`Failed to read attachment '${attachment.id}'.`, cause),
                  ),
                );
              return {
                type: "image" as const,
                url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
              } satisfies CodexSchema.V2TurnStartParams__UserInput;
            });

          const toCodexInput = (
            turnInput: Pick<ProviderAdapterV2TurnInput | ProviderAdapterV2SteerInput, "message">,
          ) =>
            Effect.gen(function* () {
              const inputItems: Array<CodexSchema.V2TurnStartParams__UserInput> = [];
              if (turnInput.message.text.length > 0) {
                inputItems.push({
                  type: "text",
                  text: turnInput.message.text,
                });
              }
              const attachmentItems = yield* Effect.forEach(
                turnInput.message.attachments,
                resolveCodexAttachment,
                { concurrency: 1 },
              );
              inputItems.push(...attachmentItems);
              if (inputItems.length === 0) {
                return yield* toProtocolError("Turn requires non-empty text or attachments.");
              }
              return inputItems;
            });

          const buildAgentMessageArtifacts = (
            context: ActiveCodexTurnContext,
            item: Extract<
              CodexSchema.V2ItemCompletedNotification__ThreadItem,
              { type: "agentMessage" }
            >,
          ) =>
            Effect.gen(function* () {
              const completedAt = yield* DateTime.now;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const ordinal = yield* resolveItemOrdinal(context, item.id);
              const messageId = idAllocator.derive.messageFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: context.startedAt,
                completedAt,
              };
              const message: OrchestrationV2ConversationMessage = {
                id: messageId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming: false,
                createdAt: completedAt,
                updatedAt: completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: context.startedAt,
                completedAt,
                updatedAt: completedAt,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming: false,
              };
              return { node, message, turnItem };
            });

          const buildCommandExecutionArtifacts = (
            context: ActiveCodexTurnContext,
            item: Extract<
              CodexSchema.V2ItemCompletedNotification__ThreadItem,
              { type: "commandExecution" }
            >,
          ) =>
            Effect.gen(function* () {
              const updatedAt = yield* DateTime.now;
              const status = codexItemStatus(item.status);
              const completedAt = status.completed ? updatedAt : null;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const ordinal = yield* resolveItemOrdinal(context, item.id);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "tool_call",
                status: status.node,
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                parentItemId: null,
                ordinal,
                status: status.turnItem,
                title: null,
                startedAt: context.startedAt,
                completedAt,
                updatedAt,
                type: "command_execution",
                input: item.command,
                ...(item.aggregatedOutput === null || item.aggregatedOutput === undefined
                  ? {}
                  : { output: item.aggregatedOutput }),
                ...(item.exitCode === null || item.exitCode === undefined
                  ? {}
                  : { exitCode: item.exitCode }),
              };
              return { node, turnItem };
            });

          const buildFileChangeArtifacts = (
            context: ActiveCodexTurnContext,
            item: Extract<
              CodexSchema.V2ItemCompletedNotification__ThreadItem,
              { type: "fileChange" }
            >,
          ) =>
            Effect.gen(function* () {
              const firstChange = item.changes[0];
              if (firstChange === undefined) {
                return null;
              }

              const updatedAt = yield* DateTime.now;
              const status = codexItemStatus(item.status);
              const completedAt = status.completed ? updatedAt : null;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: item.id,
              });
              const ordinal = yield* resolveItemOrdinal(context, item.id);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: "tool_call",
                status: status.node,
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(item.id),
                parentItemId: null,
                ordinal,
                status: status.turnItem,
                title: null,
                startedAt: context.startedAt,
                completedAt,
                updatedAt,
                type: "file_change",
                fileName: firstChange.path,
                diffStr: firstChange.diff,
              };
              return { node, turnItem };
            });

          const buildWebSearchArtifacts = (input: {
            readonly context: ActiveCodexTurnContext;
            readonly item: CodexWebSearchItem;
            readonly completed: boolean;
          }) =>
            Effect.gen(function* () {
              const updatedAt = yield* DateTime.now;
              const completedAt = input.completed ? updatedAt : null;
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.item.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.item.id,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.item.id);
              const patterns = webSearchPatterns(input.item);
              const status = input.completed ? "completed" : "running";
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "tool_call",
                status,
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.item.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: input.context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.item.id),
                parentItemId: null,
                ordinal,
                status,
                title: null,
                startedAt: input.context.startedAt,
                completedAt,
                updatedAt,
                type: "web_search",
                ...(patterns.length === 0 ? {} : { patterns: [...patterns] }),
              };
              return { node, turnItem };
            });

          const buildProposedPlanArtifacts = (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeItemId: string;
            readonly status: OrchestrationV2PlanArtifact["status"];
            readonly markdown: string;
            readonly completed?: boolean;
          }) =>
            Effect.gen(function* () {
              const updatedAt = yield* DateTime.now;
              const completedAt = input.completed === true ? updatedAt : null;
              const planId = yield* resolvePlanId(input.context, input.nativeItemId);
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
              const plan: OrchestrationV2PlanArtifact = {
                id: planId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                kind: "proposed_plan",
                status: input.status,
                markdown: input.markdown,
              };
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "plan",
                status: input.completed === true ? "completed" : "running",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: input.context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                parentItemId: null,
                ordinal,
                status: input.completed === true ? "completed" : "running",
                title: null,
                startedAt: input.context.startedAt,
                completedAt,
                updatedAt,
                type: "proposed_plan",
                planId,
                markdown: input.markdown,
                streaming: input.completed !== true,
              };
              return { node, plan, turnItem };
            });

          const buildTodoListArtifacts = (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeItemId: string;
            readonly status: OrchestrationV2PlanArtifact["status"];
            readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
            readonly explanation?: string;
            readonly completed?: boolean;
          }) =>
            Effect.gen(function* () {
              const updatedAt = yield* DateTime.now;
              const completedAt = input.completed === true ? updatedAt : null;
              const planId = yield* resolvePlanId(input.context, input.nativeItemId);
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
              const plan: OrchestrationV2PlanArtifact = {
                id: planId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                kind: "todo_list",
                status: input.status,
                steps: [...input.steps],
                ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
              };
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "todo_list",
                status: input.completed === true ? "completed" : "running",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: input.context.startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                parentItemId: null,
                ordinal,
                status: input.completed === true ? "completed" : "running",
                title: null,
                startedAt: input.context.startedAt,
                completedAt,
                updatedAt,
                type: "todo_list",
                planId,
                steps: [...input.steps],
                ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
              };
              return { node, plan, turnItem };
            });

          const buildApprovalRequestArtifacts = (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeItemId: string;
            readonly nativeRequestId: string;
            readonly requestKind: ProviderRequestKind;
            readonly prompt?: string | null;
          }) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const parentNodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(
                input.context,
                `${input.nativeItemId}:approval:${input.nativeRequestId}`,
              );
              const requestId = yield* idAllocator.allocate.runtimeRequest({
                provider: CODEX_PROVIDER,
                providerTurnId: input.context.providerTurnId,
                nativeRequestId: input.nativeRequestId,
              });
              const nodeId = idAllocator.derive.approvalNode({ requestId });
              const providerSessionId = input.context.input.providerThread.providerSessionId;
              if (providerSessionId === null) {
                return yield* toProtocolError(
                  `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
                );
              }
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "approval_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: createdAt,
                completedAt: null,
              };
              const request: OrchestrationV2RuntimeRequest = {
                id: requestId,
                nodeId,
                providerTurnId: input.context.providerTurnId,
                nativeRequestRef: {
                  provider: CODEX_PROVIDER,
                  nativeId: input.nativeRequestId,
                  strength: "strong",
                },
                kind: input.requestKind,
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId,
                },
                createdAt,
                resolvedAt: null,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: idAllocator.derive.approvalTurnItem({ requestId }),
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                parentItemId: null,
                ordinal,
                status: "waiting",
                title: null,
                startedAt: createdAt,
                completedAt: null,
                updatedAt: createdAt,
                type: "approval_request",
                requestId,
                requestKind: input.requestKind,
                ...(input.prompt === null || input.prompt === undefined
                  ? {}
                  : { prompt: input.prompt }),
              };
              return { node, request, turnItem };
            });

          const buildUserInputRequestArtifacts = (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeItemId: string;
            readonly nativeRequestId: string;
            readonly questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>;
          }) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const requestId = yield* idAllocator.allocate.runtimeRequest({
                provider: CODEX_PROVIDER,
                providerTurnId: input.context.providerTurnId,
                nativeRequestId: input.nativeRequestId,
              });
              const providerSessionId = input.context.input.providerThread.providerSessionId;
              if (providerSessionId === null) {
                return yield* toProtocolError(
                  `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
                );
              }
              const questions = input.questions.map((question, index) => ({
                id: nonEmptyText(question.id, `question-${index + 1}`),
                header: nonEmptyText(question.header, "Question"),
                question: nonEmptyText(question.question, "Choose an answer."),
                options:
                  question.options?.map((option, optionIndex) => ({
                    label: nonEmptyText(option.label, `Option ${optionIndex + 1}`),
                    description: nonEmptyText(option.description, option.label),
                  })) ?? [],
              }));
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                provider: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
              const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                parentNodeId: input.context.input.rootNodeId,
                rootNodeId: input.context.input.rootNodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: createdAt,
                completedAt: null,
              };
              const request: OrchestrationV2RuntimeRequest = {
                id: requestId,
                nodeId,
                providerTurnId: input.context.providerTurnId,
                nativeRequestRef: {
                  provider: CODEX_PROVIDER,
                  nativeId: input.nativeRequestId,
                  strength: "strong",
                },
                kind: "user_input",
                status: "pending",
                responseCapability: {
                  type: "live",
                  providerSessionId,
                },
                createdAt,
                resolvedAt: null,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: input.context.input.threadId,
                runId: input.context.input.runId,
                nodeId,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                parentItemId: null,
                ordinal,
                status: "waiting",
                title: null,
                startedAt: createdAt,
                completedAt: null,
                updatedAt: createdAt,
                type: "user_input_request",
                requestId,
                questions,
              };
              return { node, request, turnItem };
            });

          yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
            Ref.update(agentMessageDeltas, (current) => {
              const updated = new Map(current);
              updated.set(payload.itemId, `${updated.get(payload.itemId) ?? ""}${payload.delta}`);
              return updated;
            }),
          );

          yield* client.handleServerNotification("item/plan/delta", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return;
              }
              const markdown = yield* Ref.modify(planDeltas, (current) => {
                const updated = new Map(current);
                const next = `${updated.get(payload.itemId) ?? ""}${payload.delta}`;
                updated.set(payload.itemId, next);
                return [next, updated];
              });
              const artifacts = yield* buildProposedPlanArtifacts({
                context,
                nativeItemId: payload.itemId,
                status: "active",
                markdown,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "plan.updated",
                provider: CODEX_PROVIDER,
                plan: artifacts.plan,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("turn/plan/updated", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return;
              }
              const steps = payload.plan.map((step, index) => ({
                id: `step-${index + 1}`,
                text: nonEmptyText(step.step, `Step ${index + 1}`),
                status: codexPlanStepStatus(step.status),
              }));
              const explanation = trimText(payload.explanation);
              const artifacts = yield* buildTodoListArtifacts({
                context,
                nativeItemId: `turn-plan:${payload.turnId}`,
                status: "active",
                ...(explanation === undefined ? {} : { explanation }),
                steps,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "plan.updated",
                provider: CODEX_PROVIDER,
                plan: artifacts.plan,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("item/started", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined || payload.item.type !== "webSearch") {
                return;
              }

              const artifacts = yield* buildWebSearchArtifacts({
                context,
                item: payload.item,
                completed: false,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("item/completed", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return;
              }

              if (payload.item.type === "commandExecution") {
                const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
                yield* emitProviderEvent({
                  type: "node.updated",
                  provider: CODEX_PROVIDER,
                  node: artifacts.node,
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  provider: CODEX_PROVIDER,
                  turnItem: artifacts.turnItem,
                });
                return;
              }

              if (payload.item.type === "fileChange") {
                const artifacts = yield* buildFileChangeArtifacts(context, payload.item);
                if (artifacts === null) {
                  return;
                }
                yield* emitProviderEvent({
                  type: "node.updated",
                  provider: CODEX_PROVIDER,
                  node: artifacts.node,
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  provider: CODEX_PROVIDER,
                  turnItem: artifacts.turnItem,
                });
                return;
              }

              if (payload.item.type === "webSearch") {
                const artifacts = yield* buildWebSearchArtifacts({
                  context,
                  item: payload.item,
                  completed: true,
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  provider: CODEX_PROVIDER,
                  node: artifacts.node,
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  provider: CODEX_PROVIDER,
                  turnItem: artifacts.turnItem,
                });
                return;
              }

              if (payload.item.type === "plan") {
                const deltas = yield* Ref.get(planDeltas);
                const markdown =
                  payload.item.text.length > 0
                    ? payload.item.text
                    : (deltas.get(payload.item.id) ?? "");
                const artifacts = yield* buildProposedPlanArtifacts({
                  context,
                  nativeItemId: payload.item.id,
                  status: "completed",
                  markdown,
                  completed: true,
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  provider: CODEX_PROVIDER,
                  node: artifacts.node,
                });
                yield* emitProviderEvent({
                  type: "plan.updated",
                  provider: CODEX_PROVIDER,
                  plan: artifacts.plan,
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  provider: CODEX_PROVIDER,
                  turnItem: artifacts.turnItem,
                });
                return;
              }

              if (payload.item.type !== "agentMessage") {
                return;
              }

              const deltas = yield* Ref.get(agentMessageDeltas);
              const text =
                payload.item.text.length > 0
                  ? payload.item.text
                  : (deltas.get(payload.item.id) ?? "");
              const artifacts = yield* buildAgentMessageArtifacts(context, {
                ...payload.item,
                text,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                provider: CODEX_PROVIDER,
                message: artifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return yield* toProtocolError(
                  `No active Codex turn context for approval turn ${payload.turnId}.`,
                  payload,
                );
              }

              const nativeRequestId = payload.approvalId ?? payload.itemId;
              const artifacts = yield* buildApprovalRequestArtifacts({
                context,
                nativeItemId: payload.itemId,
                nativeRequestId,
                requestKind: "command",
                ...((payload.reason ?? payload.command) === undefined
                  ? {}
                  : { prompt: payload.reason ?? payload.command }),
              });
              const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
              yield* Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.set(String(artifacts.request.id), {
                  type: "approval",
                  requestId: artifacts.request.id,
                  requestKind: "command",
                  decision,
                });
                return updated;
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });

              const resolved = yield* Deferred.await(decision).pipe(
                Effect.ensuring(
                  Ref.update(pendingRuntimeRequests, (current) => {
                    const updated = new Map(current);
                    updated.delete(String(artifacts.request.id));
                    return updated;
                  }),
                ),
              );
              return {
                decision: resolved,
              } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return yield* toProtocolError(
                  `No active Codex turn context for file change approval turn ${payload.turnId}.`,
                  payload,
                );
              }

              const artifacts = yield* buildApprovalRequestArtifacts({
                context,
                nativeItemId: payload.itemId,
                nativeRequestId: payload.itemId,
                requestKind: "file-change",
                ...(payload.reason === undefined ? {} : { prompt: payload.reason }),
              });
              const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
              yield* Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.set(String(artifacts.request.id), {
                  type: "approval",
                  requestId: artifacts.request.id,
                  requestKind: "file-change",
                  decision,
                });
                return updated;
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });

              const resolved = yield* Deferred.await(decision).pipe(
                Effect.ensuring(
                  Ref.update(pendingRuntimeRequests, (current) => {
                    const updated = new Map(current);
                    updated.delete(String(artifacts.request.id));
                    return updated;
                  }),
                ),
              );
              return {
                decision: resolved,
              } satisfies CodexSchema.FileChangeRequestApprovalResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return yield* toProtocolError(
                  `No active Codex turn context for permissions approval turn ${payload.turnId}.`,
                  payload,
                );
              }

              const requestKind = providerRequestKindFromPermissions(payload.permissions);
              const artifacts = yield* buildApprovalRequestArtifacts({
                context,
                nativeItemId: payload.itemId,
                nativeRequestId: payload.itemId,
                requestKind,
                ...(payload.reason === undefined ? {} : { prompt: payload.reason }),
              });
              const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
              yield* Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.set(String(artifacts.request.id), {
                  type: "approval",
                  requestId: artifacts.request.id,
                  requestKind,
                  decision,
                });
                return updated;
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });

              const resolved = yield* Deferred.await(decision).pipe(
                Effect.ensuring(
                  Ref.update(pendingRuntimeRequests, (current) => {
                    const updated = new Map(current);
                    updated.delete(String(artifacts.request.id));
                    return updated;
                  }),
                ),
              );
              return permissionsResponseFromDecision({
                decision: resolved,
                permissions: payload.permissions,
              });
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("execCommandApproval", (payload) =>
            Effect.gen(function* () {
              const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
              if (context === undefined) {
                return yield* toProtocolError(
                  `No active Codex turn context for exec approval thread ${payload.conversationId}.`,
                  payload,
                );
              }

              const nativeRequestId = payload.approvalId ?? payload.callId;
              const artifacts = yield* buildApprovalRequestArtifacts({
                context,
                nativeItemId: payload.callId,
                nativeRequestId,
                requestKind: "command",
                prompt: payload.reason ?? payload.command.join(" "),
              });
              const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
              yield* Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.set(String(artifacts.request.id), {
                  type: "approval",
                  requestId: artifacts.request.id,
                  requestKind: "command",
                  decision,
                });
                return updated;
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });

              const resolved = yield* Deferred.await(decision).pipe(
                Effect.ensuring(
                  Ref.update(pendingRuntimeRequests, (current) => {
                    const updated = new Map(current);
                    updated.delete(String(artifacts.request.id));
                    return updated;
                  }),
                ),
              );
              return {
                decision: approvalDecisionToLegacyReviewDecision(resolved),
              } satisfies CodexSchema.ExecCommandApprovalResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("applyPatchApproval", (payload) =>
            Effect.gen(function* () {
              const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
              if (context === undefined) {
                return yield* toProtocolError(
                  `No active Codex turn context for apply patch approval thread ${payload.conversationId}.`,
                  payload,
                );
              }

              const artifacts = yield* buildApprovalRequestArtifacts({
                context,
                nativeItemId: payload.callId,
                nativeRequestId: payload.callId,
                requestKind: "file-change",
                prompt: payload.reason ?? Object.keys(payload.fileChanges).join(", "),
              });
              const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
              yield* Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.set(String(artifacts.request.id), {
                  type: "approval",
                  requestId: artifacts.request.id,
                  requestKind: "file-change",
                  decision,
                });
                return updated;
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });

              const resolved = yield* Deferred.await(decision).pipe(
                Effect.ensuring(
                  Ref.update(pendingRuntimeRequests, (current) => {
                    const updated = new Map(current);
                    updated.delete(String(artifacts.request.id));
                    return updated;
                  }),
                ),
              );
              return {
                decision: approvalDecisionToLegacyReviewDecision(resolved),
              } satisfies CodexSchema.ApplyPatchApprovalResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
              if (context === undefined) {
                return yield* toProtocolError(
                  `No active Codex turn context for user input request turn ${payload.turnId}.`,
                  payload,
                );
              }

              const artifacts = yield* buildUserInputRequestArtifacts({
                context,
                nativeItemId: payload.itemId,
                nativeRequestId: payload.itemId,
                questions: payload.questions,
              });
              const answers = yield* Deferred.make<ProviderUserInputAnswers, never>();
              yield* Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.set(String(artifacts.request.id), {
                  type: "user_input",
                  requestId: artifacts.request.id,
                  answers,
                });
                return updated;
              });
              yield* emitProviderEvent({
                type: "node.updated",
                provider: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                provider: CODEX_PROVIDER,
                runtimeRequest: artifacts.request,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });

              const resolved = yield* Deferred.await(answers).pipe(
                Effect.ensuring(
                  Ref.update(pendingRuntimeRequests, (current) => {
                    const updated = new Map(current);
                    updated.delete(String(artifacts.request.id));
                    return updated;
                  }),
                ),
              );
              return {
                answers: toCodexUserInputAnswers(resolved),
              } satisfies CodexSchema.ToolRequestUserInputResponse;
            }).pipe(Effect.orDie),
          );

          yield* client.handleServerNotification("turn/completed", (payload) =>
            Effect.gen(function* () {
              const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
              if (context === undefined) {
                return;
              }
              const completedAt = codexTimestamp(payload.turn.completedAt);
              const status = mapCodexTurnStatus(payload.turn.status);
              yield* emitProviderEvent({
                type: "provider_turn.updated",
                provider: CODEX_PROVIDER,
                providerTurn: {
                  id: context.providerTurnId,
                  providerThreadId: context.input.providerThread.id,
                  nodeId: context.input.rootNodeId,
                  runAttemptId: context.input.attemptId,
                  nativeTurnRef: {
                    provider: CODEX_PROVIDER,
                    nativeId: payload.turn.id,
                    strength: "strong",
                  },
                  ordinal: context.providerTurnOrdinal,
                  status,
                  startedAt: context.startedAt,
                  completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "turn.terminal",
                provider: CODEX_PROVIDER,
                providerTurnId: context.providerTurnId,
                status: providerTurnStatusToTerminal(status),
              });
              const waiter = (yield* Ref.get(turnWaiters)).get(payload.turn.id);
              if (waiter !== undefined) {
                yield* Deferred.succeed(waiter, undefined);
              }
              yield* Ref.update(activeTurns, (current) => {
                const updated = new Map(current);
                updated.delete(payload.turn.id);
                return updated;
              });
            }),
          );

          const runtime: ProviderAdapterV2SessionRuntime = {
            provider: CODEX_PROVIDER,
            providerSessionId: input.providerSessionId,
            providerSession: session,
            rawEvents: Stream.empty,
            events: Stream.fromQueue(events),
            ensureThread: (threadInput) =>
              ensureInitialized.pipe(
                Effect.andThen(client.request("thread/start", {})),
                Effect.map(
                  (response): OrchestrationV2ProviderThread =>
                    providerThreadFromCodexThread({
                      appThreadId: threadInput.threadId,
                      idAllocator,
                      ownerNodeId: null,
                      providerSessionId: input.providerSessionId,
                      thread: response.thread,
                    }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterEnsureThreadError({
                      provider: CODEX_PROVIDER,
                      threadId: threadInput.threadId,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              ),
            resumeThread: (threadInput) =>
              Effect.gen(function* () {
                const nativeThreadId = yield* getNativeThreadId(threadInput.providerThread);

                const response = yield* ensureInitialized.pipe(
                  Effect.andThen(client.request("thread/resume", { threadId: nativeThreadId })),
                );
                return {
                  ...threadInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  status: "idle",
                  nativeThreadRef: {
                    provider: CODEX_PROVIDER,
                    nativeId: response.thread.id,
                    strength: "strong",
                  },
                  updatedAt: codexTimestamp(response.thread.updatedAt),
                } satisfies OrchestrationV2ProviderThread;
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterResumeThreadError({
                      provider: CODEX_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              ),
            startTurn: (turnInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(turnInput.providerThread);

                const codexInput = yield* toCodexInput(turnInput);
                const turnStartParams = yield* buildTurnStartParams({
                  nativeThreadId: threadId,
                  codexInput,
                  runtimePolicy: turnInput.runtimePolicy,
                  model: turnInput.modelSelection.model,
                });
                const started = yield* client.request("turn/start", turnStartParams);
                const nativeTurnId = started.turn.id;
                const startedAt = codexTimestamp(started.turn.startedAt);
                const pTurnId = idAllocator.derive.providerTurn({
                  provider: CODEX_PROVIDER,
                  nativeTurnId,
                });
                const providerTurnOrdinal = turnInput.runOrdinal;
                const context: ActiveCodexTurnContext = {
                  input: turnInput,
                  nativeTurnId,
                  providerTurnId: pTurnId,
                  providerTurnOrdinal,
                  startedAt,
                };
                yield* Ref.update(activeTurns, (current) => {
                  const updated = new Map(current);
                  updated.set(nativeTurnId, context);
                  return updated;
                });
                yield* emitProviderEvent({
                  type: "provider_turn.updated",
                  provider: CODEX_PROVIDER,
                  providerTurn: {
                    id: pTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      provider: CODEX_PROVIDER,
                      nativeId: nativeTurnId,
                      strength: "strong",
                    },
                    ordinal: providerTurnOrdinal,
                    status: "running",
                    startedAt,
                    completedAt: null,
                  },
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterTurnStartError({
                      provider: CODEX_PROVIDER,
                      threadId: turnInput.threadId,
                      providerThreadId: turnInput.providerThread.id,
                      runId: turnInput.runId,
                      cause,
                    }),
                ),
              ),
            steerTurn: (turnInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(turnInput.providerThread);
                const activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
                  (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
                );
                if (activeTurn === undefined) {
                  return yield* toProtocolError(
                    `Provider turn ${turnInput.providerTurnId} is not active and cannot be steered.`,
                  );
                }

                const codexInput = yield* toCodexInput(turnInput);
                yield* client.request("turn/steer", {
                  expectedTurnId: activeTurn.nativeTurnId,
                  input: codexInput,
                  threadId,
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterSteerRunError({
                      provider: CODEX_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
            interruptTurn: (turnInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(turnInput.providerThread);
                const activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
                  (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
                );
                if (activeTurn === undefined) {
                  return yield* toProtocolError(
                    `Provider turn ${turnInput.providerTurnId} is not active and cannot be interrupted.`,
                  );
                }
                yield* client.request("turn/interrupt", {
                  threadId,
                  turnId: activeTurn.nativeTurnId,
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterInterruptError({
                      provider: CODEX_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
            respondToRuntimeRequest: (requestInput) =>
              Effect.gen(function* () {
                const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                  String(requestInput.requestId),
                );
                if (pending === undefined) {
                  return yield* new ProviderAdapterRuntimeRequestResponseError({
                    provider: CODEX_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: toProtocolError(
                      `No pending Codex runtime request ${requestInput.requestId}.`,
                    ),
                  });
                }
                if (pending.type === "user_input") {
                  if (requestInput.answers === undefined) {
                    return yield* new ProviderAdapterRuntimeRequestResponseError({
                      provider: CODEX_PROVIDER,
                      requestId: requestInput.requestId,
                      cause: toProtocolError(
                        `Codex user input request ${requestInput.requestId} requires answers.`,
                      ),
                    });
                  }
                  yield* Deferred.succeed(pending.answers, requestInput.answers);
                  return;
                }
                if (requestInput.decision === undefined) {
                  return yield* new ProviderAdapterRuntimeRequestResponseError({
                    provider: CODEX_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: toProtocolError(
                      `Codex ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
                    ),
                  });
                }
                yield* Deferred.succeed(pending.decision, requestInput.decision);
              }).pipe(
                Effect.mapError((cause) =>
                  Schema.is(ProviderAdapterRuntimeRequestResponseError)(cause)
                    ? cause
                    : new ProviderAdapterRuntimeRequestResponseError({
                        provider: CODEX_PROVIDER,
                        requestId: requestInput.requestId,
                        cause,
                      }),
                ),
              ),
            readThreadSnapshot: (threadInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(threadInput.providerThread);
                const response = yield* ensureInitialized.pipe(
                  Effect.andThen(client.request("thread/read", { threadId, includeTurns: true })),
                );
                return {
                  providerThread: {
                    ...threadInput.providerThread,
                    nativeThreadRef: {
                      provider: CODEX_PROVIDER,
                      nativeId: response.thread.id,
                      strength: "strong" as const,
                    },
                    updatedAt: codexTimestamp(response.thread.updatedAt),
                  },
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                  providerPayload: response.thread,
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterReadThreadSnapshotError({
                      provider: CODEX_PROVIDER,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
            rollbackThread: (threadInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(threadInput.providerThread);
                const numTurns =
                  typeof threadInput.providerPayload === "object" &&
                  threadInput.providerPayload !== null &&
                  "numTurns" in threadInput.providerPayload &&
                  typeof threadInput.providerPayload.numTurns === "number"
                    ? threadInput.providerPayload.numTurns
                    : 1;
                const response = yield* ensureInitialized.pipe(
                  Effect.andThen(client.request("thread/rollback", { threadId, numTurns })),
                );
                return {
                  providerThread: {
                    ...threadInput.providerThread,
                    nativeThreadRef: {
                      provider: CODEX_PROVIDER,
                      nativeId: response.thread.id,
                      strength: "strong" as const,
                    },
                    status: "idle" as const,
                    updatedAt: codexTimestamp(response.thread.updatedAt),
                  },
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                  providerPayload: response.thread,
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRollbackThreadError({
                      provider: CODEX_PROVIDER,
                      providerThreadId: threadInput.providerThread.id,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              ),
            forkThread: (threadInput) =>
              Effect.gen(function* () {
                const threadId = yield* getNativeThreadId(threadInput.sourceProviderThread);
                const response = yield* ensureInitialized.pipe(
                  Effect.andThen(client.request("thread/fork", { threadId })),
                );
                return providerThreadFromCodexThread({
                  appThreadId: threadInput.targetThreadId,
                  idAllocator,
                  ownerNodeId: threadInput.ownerNodeId ?? null,
                  providerSessionId: input.providerSessionId,
                  thread: response.thread,
                  forkedFrom: {
                    providerThreadId: threadInput.sourceProviderThread.id,
                    ...(threadInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: threadInput.providerTurnId }),
                  },
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterForkThreadError({
                      provider: CODEX_PROVIDER,
                      providerThreadId: threadInput.sourceProviderThread.id,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              ),
          };
          return runtime;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                provider: CODEX_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    });
  }),
);
