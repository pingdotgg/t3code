// Thread identity, lineage, context-transfer and capability schemas.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CommandId,
  ContextHandoffId,
  ContextTransferId,
  IsoDateTime,
  EnvironmentId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { AuthMcpClientAccess } from "./auth.ts";
import { ThreadGuestShare } from "./guestShare.ts";
import { StoredThreadTags } from "./threadTags.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "./threadPullRequest.ts";
import {
  ProviderInteractionMode,
  RuntimeMode,
} from "./providerPolicy.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
} from "./providerInstance.ts";

export const OrchestrationV2Actor = Schema.Literals(["user", "agent", "system"]);

export type OrchestrationV2Actor = typeof OrchestrationV2Actor.Type;

export const OrchestrationV2CreationSource = Schema.Literals([
  "web",
  "mobile",
  "mcp",
  "provider",
  "server",
]);

export type OrchestrationV2CreationSource = typeof OrchestrationV2CreationSource.Type;

export const OrchestrationV2ThreadHistoryOrigin = Schema.Literals(["native", "v1_import"]);

export type OrchestrationV2ThreadHistoryOrigin = typeof OrchestrationV2ThreadHistoryOrigin.Type;

export const OrchestrationV2CreationFields = {
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
} as const;

/**
 * The linked environment whose agent started this work here: the MCP client
 * session it signed in with, that session's label, and the access it was
 * paired with. Set when the thread is created and never changed; work derived
 * from it carries the same origin.
 */
export const OrchestrationV2LinkOrigin = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  label: Schema.String,
  access: Schema.optional(AuthMcpClientAccess),
});

export type OrchestrationV2LinkOrigin = typeof OrchestrationV2LinkOrigin.Type;

/**
 * Work from a link paired below full access may change only work from the same
 * link. A full-access link's agents already run as this environment's user,
 * so fencing T3's own tools would stop nothing they could not do anyway. An
 * origin stamped before access was recorded stays fenced.
 */
export const linkOriginIsFenced = (origin: OrchestrationV2LinkOrigin) =>
  origin.access !== "full-access";

/**
 * The thread in a linked environment that delegated this one, when it did:
 * this thread is that parent's subagent, run here instead of there.
 */
export const OrchestrationV2DelegatedFrom = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
});

export type OrchestrationV2DelegatedFrom = typeof OrchestrationV2DelegatedFrom.Type;

const OrchestrationV2NativeRefStrength = Schema.Literals(["strong", "weak", "none"]);

type OrchestrationV2NativeRefStrength = typeof OrchestrationV2NativeRefStrength.Type;

export const OrchestrationV2ProviderRef = Schema.Struct({
  driver: ProviderDriverKind,
  nativeId: Schema.NullOr(TrimmedNonEmptyString),
  strength: OrchestrationV2NativeRefStrength,
  fingerprint: Schema.optional(TrimmedNonEmptyString),
  ordinal: Schema.optional(NonNegativeInt),
});

export type OrchestrationV2ProviderRef = typeof OrchestrationV2ProviderRef.Type;

export const OrchestrationV2AppThreadLineage = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  rootThreadId: ThreadId,
  sideChat: Schema.optional(Schema.Boolean),
});

export type OrchestrationV2AppThreadLineage = typeof OrchestrationV2AppThreadLineage.Type;

/** Subagents and side chats live inside their parent's view, never in thread lists. */
export const isListedThreadLineage = (lineage: OrchestrationV2AppThreadLineage): boolean =>
  lineage.relationshipToParent !== "subagent" && lineage.sideChat !== true;

const OrchestrationV2ContextTransferType = Schema.Literals([
  "fork",
  "provider_handoff",
  "merge_back",
  "subagent_spawn",
  "subagent_result",
]);

type OrchestrationV2ContextTransferType = typeof OrchestrationV2ContextTransferType.Type;

export const OrchestrationV2ContextSourcePoint = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  checkpointId: Schema.optional(CheckpointId),
  turnItemId: Schema.optional(TurnItemId),
  providerThreadRef: Schema.optional(OrchestrationV2ProviderRef),
  providerTurnRef: Schema.optional(OrchestrationV2ProviderRef),
});

export type OrchestrationV2ContextSourcePoint = typeof OrchestrationV2ContextSourcePoint.Type;

export const OrchestrationV2ThreadForkSourcePoint = Schema.Union([
  Schema.Struct({ type: Schema.Literal("latest_stable") }),
  Schema.Struct({ type: Schema.Literal("run"), runId: RunId }),
  Schema.Struct({ type: Schema.Literal("checkpoint"), checkpointId: CheckpointId }),
]);

export type OrchestrationV2ThreadForkSourcePoint = typeof OrchestrationV2ThreadForkSourcePoint.Type;

export const OrchestrationV2ContextTransferResolution = Schema.Union([
  Schema.Struct({
    strategy: Schema.Literal("native_fork"),
    providerThreadRef: OrchestrationV2ProviderRef,
  }),
  Schema.Struct({
    strategy: Schema.Literal("portable_context"),
    contextHandoffId: ContextHandoffId,
  }),
  Schema.Struct({
    strategy: Schema.Literal("delta_context"),
    contextHandoffId: ContextHandoffId,
  }),
  Schema.Struct({
    strategy: Schema.Literal("fork_delta_context"),
    contextHandoffId: ContextHandoffId,
  }),
  Schema.Struct({
    strategy: Schema.Literal("checkpoint_context"),
    contextHandoffId: ContextHandoffId,
  }),
]);

export type OrchestrationV2ContextTransferResolution =
  typeof OrchestrationV2ContextTransferResolution.Type;

export const OrchestrationV2ProviderTurnTokenUsage = Schema.Struct({
  usedTokens: NonNegativeInt,
  maxTokens: Schema.optional(Schema.NullOr(NonNegativeInt)),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  promptCacheTtlMs: Schema.optional(PositiveInt),
  autoCompactThreshold: Schema.optional(PositiveInt),
  promptCacheExpiresAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});

export type OrchestrationV2ProviderTurnTokenUsage =
  typeof OrchestrationV2ProviderTurnTokenUsage.Type;

export const OrchestrationV2ContextTransfer = Schema.Struct({
  id: ContextTransferId,
  type: OrchestrationV2ContextTransferType,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourcePoint: OrchestrationV2ContextSourcePoint,
  basePoint: Schema.NullOr(OrchestrationV2ContextSourcePoint),
  sourceProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  sourceTokenUsage: Schema.optional(OrchestrationV2ProviderTurnTokenUsage),
  targetProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  targetRunId: Schema.NullOr(RunId),
  status: Schema.Literals([
    "pending",
    "resolved_native",
    "resolved_portable",
    "failed",
    "consumed",
    "superseded",
  ]),
  resolution: Schema.NullOr(OrchestrationV2ContextTransferResolution),
  createdBy: OrchestrationV2Actor,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  consumedAt: Schema.NullOr(Schema.DateTimeUtc),
});

export type OrchestrationV2ContextTransfer = typeof OrchestrationV2ContextTransfer.Type;

const OrchestrationV2SessionCapabilities = Schema.Struct({
  supportsMultipleProviderThreadsPerSession: Schema.Boolean,
  supportsModelSwitchInSession: Schema.Boolean,
  supportsProviderSwitchingViaHandoff: Schema.Boolean,
  supportsRuntimeModeSwitchInSession: Schema.Boolean,
  pendingRequestsSurviveRestart: Schema.Boolean,
});

type OrchestrationV2SessionCapabilities = typeof OrchestrationV2SessionCapabilities.Type;

const OrchestrationV2ThreadCapabilities = Schema.Struct({
  canCreateEmptyThread: Schema.Boolean,
  canReadThreadSnapshot: Schema.Boolean,
  canRollbackThread: Schema.Boolean,
  canForkThread: Schema.Boolean,
  canForkFromTurn: Schema.Boolean,
  canForkFromSubagentThread: Schema.Boolean,
  exposesNativeThreadId: Schema.Boolean,
});

type OrchestrationV2ThreadCapabilities = typeof OrchestrationV2ThreadCapabilities.Type;

const OrchestrationV2TurnCapabilities = Schema.Struct({
  exposesNativeTurnId: Schema.Boolean,
  emitsTurnStarted: Schema.Boolean,
  emitsTurnCompleted: Schema.Boolean,
  supportsInterrupt: Schema.Boolean,
  supportsActiveSteering: Schema.Boolean,
  // Some native steering mechanisms cancel pending tools before consuming the message.
  activeSteeringInterruptsTools: Schema.optional(Schema.Boolean),
  // Some take text only, so a steer with attachments restarts the turn instead.
  activeSteeringAcceptsAttachments: Schema.optional(Schema.Boolean),
  supportsSteeringByInterruptRestart: Schema.Boolean,
  supportsQueuedMessages: Schema.Boolean,
  terminalStatusQuality: Schema.Literals(["strong", "weak", "none"]),
});

type OrchestrationV2TurnCapabilities = typeof OrchestrationV2TurnCapabilities.Type;

const OrchestrationV2StreamingCapabilities = Schema.Struct({
  streamsAssistantText: Schema.Boolean,
  streamsReasoning: Schema.Boolean,
  streamsToolOutput: Schema.Boolean,
  streamsPlanText: Schema.Boolean,
  emitsMessageCompleted: Schema.Boolean,
});

type OrchestrationV2StreamingCapabilities = typeof OrchestrationV2StreamingCapabilities.Type;

const OrchestrationV2ToolCapabilities = Schema.Struct({
  exposesToolItemIds: Schema.Boolean,
  emitsToolStarted: Schema.Boolean,
  emitsToolCompleted: Schema.Boolean,
  emitsToolOutput: Schema.Boolean,
  supportsMcpTools: Schema.Boolean,
  supportsDynamicToolCallbacks: Schema.Boolean,
});

type OrchestrationV2ToolCapabilities = typeof OrchestrationV2ToolCapabilities.Type;

const OrchestrationV2ApprovalCapabilities = Schema.Struct({
  supportsCommandApproval: Schema.Boolean,
  supportsFileReadApproval: Schema.Boolean,
  supportsFileChangeApproval: Schema.Boolean,
  supportsApplyPatchApproval: Schema.Boolean,
  approvalsHaveNativeRequestIds: Schema.Boolean,
  approvalCallbacksAreLiveOnly: Schema.Boolean,
  approvalsCanOriginateFromSubagents: Schema.Boolean,
});

type OrchestrationV2ApprovalCapabilities = typeof OrchestrationV2ApprovalCapabilities.Type;

const OrchestrationV2PlanningCapabilities = Schema.Struct({
  emitsPlanUpdated: Schema.Boolean,
  emitsTodoList: Schema.Boolean,
  emitsProposedPlan: Schema.Boolean,
  supportsStructuredQuestions: Schema.Boolean,
  planDeltasHaveItemIds: Schema.Boolean,
});

type OrchestrationV2PlanningCapabilities = typeof OrchestrationV2PlanningCapabilities.Type;

const OrchestrationV2SubagentCapabilities = Schema.Struct({
  supportsSubagents: Schema.Boolean,
  exposesSubagentThreadIds: Schema.Boolean,
  emitsSubagentLifecycle: Schema.Boolean,
  canWaitForSubagents: Schema.Boolean,
  canCloseSubagents: Schema.Boolean,
  canForkSubagentThread: Schema.Boolean,
});

type OrchestrationV2SubagentCapabilities = typeof OrchestrationV2SubagentCapabilities.Type;

const OrchestrationV2ContextCapabilities = Schema.Struct({
  acceptsSystemContext: Schema.Boolean,
  acceptsDeveloperContext: Schema.Boolean,
  acceptsSyntheticUserContext: Schema.Boolean,
  canGenerateSummaries: Schema.Boolean,
  canConsumeHandoffSummaries: Schema.Boolean,
  supportsDeltaHandoff: Schema.Boolean,
  supportsFullThreadHandoff: Schema.Boolean,
  maxRecommendedHandoffChars: Schema.NullOr(PositiveInt),
});

type OrchestrationV2ContextCapabilities = typeof OrchestrationV2ContextCapabilities.Type;

const OrchestrationV2CheckpointCapabilities = Schema.Struct({
  appCanCheckpointFilesystem: Schema.Boolean,
  supportsNestedCheckpointScopes: Schema.Boolean,
  providerCanRollbackConversation: Schema.Boolean,
  providerRollbackReturnsSnapshot: Schema.Boolean,
  providerCanReadConversationSnapshot: Schema.Boolean,
});

type OrchestrationV2CheckpointCapabilities =
  typeof OrchestrationV2CheckpointCapabilities.Type;

const OrchestrationV2RuntimePolicyCapabilities = Schema.Struct({
  enforcement: Schema.Literals(["native", "client-boundary"]),
});

type OrchestrationV2RuntimePolicyCapabilities =
  typeof OrchestrationV2RuntimePolicyCapabilities.Type;

const OrchestrationV2IdentityCapabilities = Schema.Struct({
  nativeThreadIds: OrchestrationV2NativeRefStrength,
  nativeTurnIds: OrchestrationV2NativeRefStrength,
  nativeItemIds: OrchestrationV2NativeRefStrength,
  nativeRequestIds: OrchestrationV2NativeRefStrength,
});

type OrchestrationV2IdentityCapabilities = typeof OrchestrationV2IdentityCapabilities.Type;

export const OrchestrationV2ProviderCapabilities = Schema.Struct({
  sessions: OrchestrationV2SessionCapabilities,
  threads: OrchestrationV2ThreadCapabilities,
  turns: OrchestrationV2TurnCapabilities,
  streaming: OrchestrationV2StreamingCapabilities,
  tools: OrchestrationV2ToolCapabilities,
  approvals: OrchestrationV2ApprovalCapabilities,
  planning: OrchestrationV2PlanningCapabilities,
  subagents: OrchestrationV2SubagentCapabilities,
  context: OrchestrationV2ContextCapabilities,
  checkpointing: OrchestrationV2CheckpointCapabilities,
  identity: OrchestrationV2IdentityCapabilities,
  // Replay defaults old events to the weaker client-boundary guarantee.
  runtimePolicy: OrchestrationV2RuntimePolicyCapabilities.pipe(
    Schema.withDecodingDefault(Effect.succeed({ enforcement: "client-boundary" as const })),
  ),
});

export type OrchestrationV2ProviderCapabilities = typeof OrchestrationV2ProviderCapabilities.Type;

export const OrchestrationV2LimitRecovery = Schema.Struct({
  requestId: Schema.optional(CommandId),
  runId: RunId,
  resetAt: IsoDateTime,
  autoResume: Schema.Boolean,
  snooze: Schema.optional(Schema.Boolean),
});

export type OrchestrationV2LimitRecovery = typeof OrchestrationV2LimitRecovery.Type;

export const OrchestrationV2LimitRecoveryUpdate = Schema.Struct({
  runId: RunId,
  resetAt: IsoDateTime,
  autoResume: Schema.optional(Schema.Boolean),
  snooze: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (update) =>
      update.autoResume !== undefined ||
      update.snooze !== undefined ||
      "A recovery update must include autoResume or snooze.",
  ),
);

export type OrchestrationV2LimitRecoveryUpdate = typeof OrchestrationV2LimitRecoveryUpdate.Type;

/**
 * `score` is an open count that halves every two weeks, as of `openedAt`.
 * `picks` stores lowercase palette queries, newest first.
 * Times are epoch milliseconds for ranking arithmetic.
 */
export const OrchestrationV2ThreadOpens = Schema.Struct({
  openedAt: Schema.Finite,
  score: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  picks: Schema.Array(
    Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(32)), at: Schema.Finite }),
  ).check(Schema.isMaxLength(3)),
});

export type OrchestrationV2ThreadOpens = typeof OrchestrationV2ThreadOpens.Type;

// Open stats only rank search results, so a value this build cannot read (an
// older or newer shape) becomes null instead of failing the whole thread.
export const LenientThreadOpens = Schema.NullOr(OrchestrationV2ThreadOpens).pipe(
  Schema.catchDecoding(() => Effect.succeedSome(null)),
);

export const OrchestrationV2AppThread = Schema.Struct({
  ...OrchestrationV2CreationFields,
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  historyOrigin: Schema.optional(OrchestrationV2ThreadHistoryOrigin),
  linkOrigin: Schema.optional(OrchestrationV2LinkOrigin),
  delegatedFrom: Schema.optional(OrchestrationV2DelegatedFrom),
  lineage: OrchestrationV2AppThreadLineage,
  forkedFrom: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("run"), threadId: ThreadId, runId: RunId }),
      Schema.Struct({ type: Schema.Literal("node"), nodeId: NodeId }),
      Schema.Struct({
        type: Schema.Literal("provider_thread"),
        providerThreadId: ProviderThreadId,
        providerTurnId: Schema.optional(ProviderTurnId),
      }),
    ]),
  ),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  archivedAt: Schema.NullOr(Schema.DateTimeUtc),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  unsettledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  snoozedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  lastSnoozeWakeAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  limitRecovery: Schema.optional(Schema.NullOr(OrchestrationV2LimitRecovery)),
  guestShare: Schema.optional(Schema.NullOr(ThreadGuestShare)),
  pinnedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Absent on threads written before tags existed; read as empty. */
  tags: Schema.optional(StoredThreadTags),
  lastVisitedAt: Schema.NullOr(Schema.DateTimeUtc).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  opens: Schema.optional(LenientThreadOpens),
  titleRegeneration: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        startedAt: Schema.DateTimeUtc,
      }),
    ),
  ),
  rollbackRequestId: Schema.optional(CommandId),
  rollbackFailure: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        requestId: CommandId,
        message: TrimmedNonEmptyString,
      }),
    ),
  ),
  deletedAt: Schema.NullOr(Schema.DateTimeUtc),
});

export type OrchestrationV2AppThread = typeof OrchestrationV2AppThread.Type;

/** Provider-native children cannot receive messages; T3 delegate_task children can. */
export function isProviderNativeSubagentThread(
  thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">,
): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.creationSource === "provider";
}

export const IDLE_COMPACTION_TEXT = "/compact";

/** Why T3 Code compacted a thread on its own, on the `/compact` it sent. */
export const OrchestrationV2IdleCompaction = Schema.Literals(["beforeCacheExpires", "onReturn"]);

export type OrchestrationV2IdleCompaction = typeof OrchestrationV2IdleCompaction.Type;

interface CompactionMessageFields {
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
  readonly idleCompaction?: OrchestrationV2IdleCompaction | undefined;
}

/** A prompt that only asks the provider to compact, so its turn is the compaction itself. */
export function isCompactionCommandMessage(message: CompactionMessageFields): boolean {
  return (
    message.role === "user" &&
    message.text.trim().toLowerCase() === IDLE_COMPACTION_TEXT &&
    (message.attachments?.length ?? 0) === 0
  );
}

export type OrchestrationV2GoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

/** Reads a `/goal` control message. Messages with attachments are ordinary prompts. */
export function parseGoalCommand(message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}): OrchestrationV2GoalCommand | null {
  if ((message.attachments?.length ?? 0) > 0) return null;
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(message.text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

/** Why T3 Code sent this `/compact` on its own, or undefined for one someone asked for. */
export function idleCompactionOf(
  message: CompactionMessageFields,
): OrchestrationV2IdleCompaction | undefined {
  if (!isCompactionCommandMessage(message)) return undefined;
  if (message.idleCompaction !== undefined) return message.idleCompaction;
  // Servers before `idleCompaction` marked their own as agent-created.
  return message.createdBy === "agent" && message.creationSource === "server"
    ? "beforeCacheExpires"
    : undefined;
}
