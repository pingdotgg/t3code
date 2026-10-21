import * as NodeURL from "node:url";

import {
  AbsolutePath,
  Agent,
  Form,
  Location,
  Model,
  Permission,
  Provider,
  Session,
  SessionMessage,
  Skill,
  type OpenCodeEvent,
} from "@opencode/client/effect";
import { Mcp } from "@opencode/schema/mcp";
import {
  isOrchestrationV2WorkActive,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type MessageId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type RunId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";

import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  backgroundWorkNotification,
  type BackgroundWorkReport,
} from "@t3tools/provider-core/server/notification";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { OPENCODE_PROVIDER, openCodePermissionRequestKind } from "../adapter.ts";
import { openCodeToolTurnItem } from "../toolItems.ts";

const OpenCode2ProviderCapabilities = {
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
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
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
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
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
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
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
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;
type Tokens = EventOf<"session.step.ended">["data"]["tokens"];

interface TurnOwner {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly runId: RunId | null;
  readonly runOrdinal: number;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "cwd">;
}

interface ActiveTurn {
  readonly input: TurnOwner;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly texts: Map<string, OpenBlock>;
  readonly tools: Map<string, { readonly name: string; input: Record<string, unknown> }>;
  readonly startedAt: Map<string, DateTime.Utc>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  readonly usage: {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  steps: number;
  lastStep: Tokens | undefined;
  before: string | null | undefined;
  compaction: { readonly nativeId: string; readonly startedAt: DateTime.Utc } | undefined;
  compactions: number;
  retry:
    | {
        readonly retry: OrchestrationV2ProviderRetry;
        readonly failure: OrchestrationV2ProviderFailure;
        readonly startedAt: DateTime.Utc;
      }
    | undefined;
  interrupted: boolean;
  unsent: boolean;
  readonly steers: Set<string>;
  readonly settledInbox: Set<string>;
  heldEnd: TurnTerminal | undefined;
  awaitingStart: boolean;
  /**
   * Prefixes a subagent session's tool ids in native item ids: the model
   * names tool calls, so a child's could repeat its parent's.
   */
  readonly scope: string;
  usedSubagents: boolean;
}

interface SubagentCall {
  readonly toolId: string;
  readonly nativeId: string;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  prompt: string;
  title: string | null;
  agent: string | undefined;
  model: string | null;
  background: boolean;
  joined: SubagentCall | undefined;
  child: ThreadState | undefined;
  status: OrchestrationV2Subagent["status"];
  result: string | null;
  completedAt: DateTime.Utc | null;
}

interface Wake {
  readonly messageId: MessageId | undefined;
  readonly events: Array<OpenCode2Client.OpenCode2StreamEvent>;
  running: boolean;
  readonly reports: Array<BackgroundWorkReport>;
  readonly detail: string | null;
  dropped: boolean;
  readonly after: string | undefined;
  readonly first: string | undefined;
  readonly children: Set<string>;
}

interface OpenBlock {
  readonly block: { readonly assistantMessageID: string; readonly ordinal: number };
  readonly kind: "text" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ThreadState {
  readonly sessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  active: ActiveTurn | undefined;
  model: ModelRef | undefined;
  /**
   * Set when a turn ended here while OpenCode may still be running it: a Stop
   * that timed out, a prompt whose request failed without a clear answer, or a
   * request T3 could not answer. Execution events carry only the session id,
   * so the next execution end belongs to that run; it clears this and ends no turn.
   */
  unsettled: boolean;
  /**
   * A prompt whose request failed may start its run late; that start is the
   * run's own, and only a start after it means its end was lost.
   */
  unsettledStarted: boolean;
  directory: string;
  agent: string;
  title: string | undefined;
  rules: ReadonlyArray<Rule> | undefined;
  policy: RulesPolicy;
  readonly grants: Array<Rule>;
  readonly calls: Map<string, SubagentCall>;
  subagent:
    | {
        call: SubagentCall;
        readonly appThread: OrchestrationV2AppThread;
        turns: number;
        prompt: string | undefined;
        queued: string | undefined;
      }
    | undefined;
  readonly wakes: Array<Wake>;
  readonly reports: Map<
    string,
    {
      readonly inboxId: string;
      readonly childId: string;
      readonly report: BackgroundWorkReport;
      readonly text: string;
    }
  >;
  readonly stoppedChildren: Set<string>;
  readonly strandedSteers: Set<string>;
  mcp:
    | { readonly name: string; readonly directory: string; readonly credential: string }
    | undefined;
  instructions: string | undefined;
}

type TurnTerminal =
  | { readonly status: "completed" | "interrupted" }
  | { readonly status: "failed"; readonly failure: ReturnType<typeof makeProviderFailure> };

type Rule = Permission.Rule;
type RulesPolicy = Pick<
  ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  "runtimeMode" | "interactionMode"
>;
type NativeForm = EventOf<"form.created">["data"]["form"];

interface PendingRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly node: OrchestrationV2ExecutionNode;
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly sessionId: string;
  answering: boolean;
  readonly native:
    | {
        readonly type: "permission";
        readonly id: string;
        readonly action: string;
        readonly resources: ReadonlyArray<string>;
        readonly save: ReadonlyArray<string>;
      }
    | { readonly type: "form"; readonly id: string; readonly form: NativeForm };
}

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });

/**
 * OpenCode skips every tool of a server whose name is over 64 characters (its
 * tool namespace limit), and its router rejects adding one over 100, so a
 * thread id that does not fit is replaced by a digest of it.
 */
export const t3McpServerName = Effect.fn("t3McpServerName")(function* (threadId: string) {
  const name = `t3-code-${threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (name.length <= 64) return name;
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(threadId))
    .pipe(Effect.orDie);
  return `t3-code-${Hex.encode(digest).slice(0, 16)}`;
});

/**
 * The rules that keep T3's MCP servers to their own thread, after the mode's:
 * the last matching rule wins, so every thread's T3 server is denied and then
 * this thread's own is allowed again, in every mode.
 */
const mcpRules = (mcpServerName: string | null): ReadonlyArray<Rule> =>
  mcpServerName === null
    ? []
    : [
        { action: "t3-code-*", resource: "*", effect: "deny" },
        { action: `${mcpServerName}_*`, resource: "*", effect: "allow" },
      ];

const sessionRules = (
  policy: RulesPolicy,
  paths: ReadonlyArray<Rule>,
  grants: ReadonlyArray<Rule>,
  mcpServerName: string | null,
): ReadonlyArray<Rule> => [
  ...(policy.runtimeMode === "full-access"
    ? [rule("*", "allow")]
    : [
        rule("shell", "ask"),
        rule("edit", policy.runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
        rule("external_directory", "ask"),
      ]),
  ...grants,
  // Plan mode writes only its plan, which `paths` allows again. Shell and read
  // are never denied: the free tier refuses sessions whose rules deny them.
  ...(policy.interactionMode === "plan" ? [rule("edit", "deny")] : []),
  ...paths,
  ...mcpRules(mcpServerName),
];

const sameRules = (left: ReadonlyArray<Rule> | undefined, right: ReadonlyArray<Rule>) =>
  left?.length === right.length &&
  left.every(
    (entry, index) =>
      entry.action === right[index]?.action &&
      entry.resource === right[index]?.resource &&
      entry.effect === right[index]?.effect,
  );

/**
 * A reject without a message is OpenCode's "stop": it ends the whole execution,
 * which is Cancel.
 */
const DECLINED = "The user declined this request.";

/**
 * Steered into the session before a decline: a declined shell call reaches the
 * model only as "Unable to execute command", which it retries.
 */
const declinedNote = (action: string, resources: ReadonlyArray<string>) =>
  `The user declined the ${action} request${resources.length === 0 ? "" : ` (${resources.join(", ")})`}. Do not retry it; continue without it or ask the user how to proceed.`;

const sessionGrantLabel = (action: string, save: ReadonlyArray<string>) =>
  save.every((pattern) => pattern === "*")
    ? `Allow every ${action} request this session`
    : `Allow ${save.join(", ")} this session`;

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

const formQuestions = (
  form: NativeForm,
):
  | { readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion> }
  | { readonly unsupported: string } => {
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type === "external") return { unsupported: "a link to open" };
    if (field.type !== "string" && field.type !== "multiselect") {
      return { unsupported: `a ${field.type} value` };
    }
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = text(field.title, `Question ${index + 1}`);
    const options = (field.options ?? []).map((option) => {
      const label = text(option.label, text(option.value, "Option"));
      return { label, description: text(option.description, label), value: option.value };
    });
    questions.push({
      id: field.key,
      header,
      question: text(field.description, header),
      options,
      multiSelect: field.type === "multiselect",
      allowCustomAnswer: field.custom === true || options.length === 0,
    });
  }
  return { questions };
};

const formAnswer = (form: NativeForm, answers: Readonly<Record<string, unknown>>) => {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (values.length > 0) {
      answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
    }
  }
  return answer;
};

const approves = (decision: ProviderApprovalDecision) =>
  decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";

const permissionGone = {
  PermissionNotFoundError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};
const formGone = {
  FormNotFoundError: () => Effect.void,
  FormAlreadySettledError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};

const agentPaths = (rules: ReadonlyArray<Rule>) =>
  rules.filter(
    (entry) =>
      entry.effect === "allow" &&
      entry.resource !== "*" &&
      (entry.action === "edit" || entry.action === "external_directory"),
  );

const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: OPENCODE_PROVIDER,
  nativeId,
  strength,
});

const sessionIdOf = (providerThread: OrchestrationV2ProviderThread) => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return nativeId === undefined || nativeId === null
    ? Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `Provider thread ${providerThread.id} has no OpenCode session`,
        }),
      )
    : Effect.succeed(nativeId);
};

const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

const stringField = (record: Readonly<Record<string, unknown>> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const reportOutcome = (state: string | undefined) =>
  state === "completed"
    ? ("completed" as const)
    : state === "error"
      ? ("failed" as const)
      : state === "cancelled"
        ? ("cancelled" as const)
        : ("unknown" as const);

const subagentOutput = (text: string) =>
  /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(text.trim())?.[1] ?? text;

const isContinuation = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";

const wakeTurnId = (sessionId: string, attemptId: string) => `${sessionId}:wake:${attemptId}`;
const isWakeTurn = (turn: OrchestrationV2ProviderTurn) =>
  turn.nativeTurnRef?.nativeId?.includes(":wake:") === true;

const INTERRUPT_TIMEOUT = "10 seconds";
const INSTRUCTIONS_KEY = "t3-code";
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = "2 seconds";
const RECONCILE_TIMEOUT = "15 seconds";
const RECONNECT_WAIT = "30 seconds";
const LOST_BACKGROUND =
  "T3 Code lost its connection to OpenCode while this subagent ran, so its result is not shown.";
const INVENTORY_TIMEOUT = "5 seconds";
const ACTIVE_CHECK_TIMEOUT = "5 seconds";
/** Answers that mean the server refused a prompt; any other failure may have been accepted. */
const CLEAR_PROMPT_REJECTIONS: ReadonlySet<string> = new Set([
  "InvalidRequestError",
  "ConflictError",
  "UnauthorizedError",
  "CommandNotFoundError",
  "SkillNotFoundError",
]);

export const OPENCODE_2_STILL_STOPPING =
  "OpenCode is still stopping the previous turn. Send the message again in a moment.";
const REQUEST_REPLY_TIMEOUT = "10 seconds";

const deliver = <E>(answer: Effect.Effect<void, E>) =>
  answer.pipe(
    Effect.retry({ times: 1 }),
    Effect.timeout(REQUEST_REPLY_TIMEOUT),
    Effect.exit,
    Effect.map(Exit.isSuccess),
  );

type ModelRef = ReturnType<typeof Model.Ref.make>;

/**
 * OpenCode takes a client id (it must start with `msg_`) and answers a repeat of one in the same
 * session with the item it already has, so a retried request never queues a second message, and a
 * turn knows the message fork and rollback cut at before OpenCode answers. The id is unique across
 * the whole server, which refuses it in any other session (409), so it names the session: another
 * T3 database or environment on the same server repeats thread ids and run ordinals, never session
 * ids.
 */
const turnPromptId = (sessionId: string, attemptId: string) =>
  SessionMessage.ID.make(`msg_t3_turn_${sessionId}:${attemptId}`);
const steerPromptId = (sessionId: string, messageId: string) =>
  SessionMessage.ID.make(`msg_t3_steer_${sessionId}:${messageId}`);

const promptOf = (turn: OrchestrationV2ProviderTurn) => {
  const nativeId = turn.nativeTurnRef?.nativeId;
  return nativeId?.startsWith("msg_") === true ? nativeId : undefined;
};

const boundaryAfter = (
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  kept: OrchestrationV2ProviderTurn | undefined,
  prompts: ReadonlySet<string>,
) => {
  const later = turns
    .filter(
      (turn) =>
        turn.providerThreadId === providerThreadId &&
        (kept === undefined || turn.ordinal > kept.ordinal),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (later.some((turn) => promptOf(turn) === undefined && !isWakeTurn(turn))) {
    return Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver: OPENCODE_PROVIDER,
        detail:
          "This OpenCode conversation has turns from an earlier T3 Code version, so it can't be cut there.",
      }),
    );
  }
  return Effect.succeed(
    later.map(promptOf).find((messageId) => messageId !== undefined && prompts.has(messageId)) ??
      null,
  );
};

const isProviderAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);

const modelRef = (selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"]) => {
  const parsed = OpenCodeRuntime.parseOpenCodeModelSlug(selection.model);
  if (parsed === null) return undefined;
  const variant = getModelSelectionStringOptionValue(selection, "variant");
  return Model.Ref.make({
    providerID: Provider.ID.make(parsed.providerID),
    id: Model.ID.make(parsed.modelID),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  });
};
const malformedModel = (model: string) =>
  `OpenCode model '${model}' must use provider/model format`;
const sameModel = (left: ModelRef, right: ModelRef | undefined) =>
  left.providerID === right?.providerID &&
  left.id === right?.id &&
  (left.variant ?? "default") === (right?.variant ?? "default");

const agentFor = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  input.runtimePolicy.interactionMode === "plan" ? "plan" : "build";

const commandOf = (text: string) => {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? undefined : { name: match[1]!, text: match[2] ?? "" };
};

const SKILL_MENTION = new RegExp(SKILL_MENTION_PATTERN.source, "u");

const skillsNamed = (text: string, known: ReadonlySet<string>) => [
  ...new Set(
    [...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) =>
      known.has(match[2] ?? "") ? [match[2]!] : [],
    ),
  ),
];

const turnTokenUsage = (turn: ActiveTurn, status: OrchestrationV2ProviderTurn["status"]) =>
  turn.steps === 0
    ? {
        usageScope: "main_agent" as const,
        usageStatus: "unavailable" as const,
        hasSubagents: turn.usedSubagents,
      }
    : {
        usageScope: "main_agent" as const,
        usageStatus: status === "completed" ? ("complete" as const) : ("partial" as const),
        inputTokens: turn.usage.input,
        cachedInputTokens: turn.usage.cached,
        cacheCreationTokens: turn.usage.cacheWrite,
        outputTokens: turn.usage.output,
        reasoningTokens: turn.usage.reasoning,
        hasSubagents: turn.usedSubagents,
      };

export const make = Effect.fn("OpenCode2Adapter.make")(function* (instanceId: ProviderInstanceId) {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const fileSystem = yield* FileSystem.FileSystem;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const crypto = yield* Crypto.Crypto;
  const driver = OPENCODE_PROVIDER;
  const mcpServerNameFor = (threadId: string) =>
    t3McpServerName(threadId).pipe(Effect.provideService(Crypto.Crypto, crypto));

  const borrow = Effect.gen(function* () {
    const lent = yield* Deferred.make<
      OpenCode2Server.OpenCode2Connection,
      OpenCodeRuntime.OpenCodeRuntimeError
    >();
    yield* server
      .withConnection((connection) =>
        Deferred.succeed(lent, connection).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(
        Effect.catch((error) => Deferred.fail(lent, error)),
        Effect.forkScoped,
      );
    return yield* Deferred.await(lent);
  });

  const openSession = Effect.fn("OpenCode2Adapter.openSession")(function* (
    input: Parameters<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>[0],
    initial: {
      readonly connection: OpenCode2Server.OpenCode2Connection;
      readonly scope: Scope.Closeable;
    },
  ) {
    let connection = initial.connection;
    let client = connection.client;
    const sessionScope = yield* Effect.scope;
    // Context windows by directory, then `provider/model`: a project's own
    // OpenCode config can change a model's limits, and this one runtime serves
    // the instance's threads in every directory.
    const contextWindows = new Map<string, Map<string, number>>();
    const directoryOf = (cwd: string | null | undefined) => cwd ?? host.paths.cwd;
    const windowOf = (cwd: string | null | undefined, model: string) =>
      contextWindows.get(directoryOf(cwd))?.get(model);
    const now = yield* DateTime.now;
    let session: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
      model: input.modelSelection.model,
      capabilities: OpenCode2ProviderCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    const threads = new Map<string, ThreadState>();
    const childOwners = new Map<string, ThreadState>();
    const announced = new Map<string, EventOf<"session.created">["data"]>();
    const strays = new Map<string, ThreadState>();
    const busy = new Set<string>();
    const pending = new Map<RuntimeRequestId, PendingRequest>();
    const lock = yield* Semaphore.make(1);
    const clearing = new Map<string, Deferred.Deferred<void>>();
    const stagedReverts = new Set<string>();
    const sessionGates = yield* KeyedLock.make<string>();
    const exclusive =
      (providerThread: OrchestrationV2ProviderThread) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const sessionId = providerThread.nativeThreadRef?.nativeId;
        if (sessionId == null) return effect;
        return sessionGates.withLock(sessionId, effect);
      };
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(events, event).pipe(Effect.asVoid);
    const ownerOf = (sessionId: string) => childOwners.get(sessionId) ?? threads.get(sessionId);
    const markUnsettled = (state: ThreadState) => {
      state.unsettled = true;
      state.unsettledStarted = busy.has(state.sessionId);
    };

    const newThreadState = (
      sessionId: string,
      providerThread: OrchestrationV2ProviderThread,
      directory: string,
      subagent: ThreadState["subagent"],
    ): ThreadState => ({
      sessionId,
      providerThread,
      providerTurns: new Map(),
      active: undefined,
      model: undefined,
      unsettled: false,
      unsettledStarted: false,
      directory,
      agent: "build",
      title: undefined,
      rules: undefined,
      policy: input.runtimePolicy,
      grants: [],
      calls: new Map(),
      subagent,
      wakes: [],
      reports: new Map(),
      stoppedChildren: new Set(),
      strandedSteers: new Set(),
      mcp: undefined,
      instructions: undefined,
    });

    const rootOf = (state: ThreadState): ThreadState => {
      let current = state;
      while (current.subagent !== undefined) current = current.subagent.call.state;
      return current;
    };

    const sessionsOf = (thread: ThreadState): ReadonlyArray<ThreadState> => [
      thread,
      ...[...threads.values()].filter((state) => {
        for (let above = state.subagent?.call.state; above; above = above.subagent?.call.state) {
          if (above === thread) return true;
        }
        return false;
      }),
    ];

    const runningCalls = (thread: ThreadState): ReadonlyArray<SubagentCall> =>
      sessionsOf(thread).flatMap((state) => [...state.calls.values()]);

    /**
     * The calls a subagent session answers for: the one that launched it and
     * the ones that joined it while it ran.
     */
    const callsAttachedTo = (child: ThreadState): ReadonlyArray<SubagentCall> => {
      const parent = child.subagent?.call.state;
      if (parent === undefined) return [];
      return [...parent.calls.values()].filter((candidate) => candidate.child === child);
    };

    const callsAbove = (sessionId: string) => {
      const calls: Array<SubagentCall> = [];
      let current = threads.get(sessionId);
      while (current?.subagent !== undefined) {
        calls.push(current.subagent.call);
        current = current.subagent.call.state;
      }
      return calls;
    };

    const requestTurn = (sessionId: string) => {
      const state = ownerOf(sessionId);
      if (state === undefined) return undefined;
      const background = callsAbove(sessionId).findLast((call) => call.background);
      if (background !== undefined) {
        return isOrchestrationV2WorkActive(background.status)
          ? { state, turn: background.turn }
          : undefined;
      }
      return state.active === undefined ? undefined : { state, turn: state.active };
    };

    const owesWork = (state: ThreadState) =>
      state.wakes.length > 0 ||
      state.reports.size > 0 ||
      (state.subagent !== undefined && busy.has(state.sessionId)) ||
      [...state.calls.values()].some((call) => call.background);

    const hasBackground = (thread: ThreadState) => sessionsOf(thread).some(owesWork);

    const setSessionStatus =
      /* Provider events include streaming deltas; avoid a span for each update. */
      Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null,
      ) {
        // The session is shared by every thread on this instance and is persisted
        // once per attached thread, so a repeat of the same state is not worth a write.
        if (session.status === status && session.lastError === lastError) return;
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver, providerSession: session });
      });

    const ordinalOf = (turn: ActiveTurn, nativeId: string) => {
      const known = turn.ordinals.get(nativeId);
      if (known !== undefined) return known;
      const next = turn.nextOrdinal++;
      turn.ordinals.set(nativeId, next);
      return next;
    };

    const itemBase = (
      state: ThreadState,
      turn: ActiveTurn,
      nativeId: string,
      status: OrchestrationV2TurnItem["status"],
      startedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null,
      updatedAt: DateTime.Utc,
    ) => ({
      id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: nativeId }),
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
      providerThreadId: state.providerThread.id,
      providerTurnId: turn.providerTurn.id,
      nativeItemRef: ref(nativeId),
      parentItemId: null,
      ordinal: ordinalOf(turn, nativeId),
      status,
      title: null,
      startedAt,
      completedAt,
      updatedAt,
    });

    const emitNode = (
      state: ThreadState,
      turn: ActiveTurn,
      nativeId: string,
      kind: OrchestrationV2ExecutionNode["kind"],
      status: OrchestrationV2ExecutionNode["status"],
      startedAt: DateTime.Utc,
      completedAt: DateTime.Utc | null,
    ) =>
      emit({
        type: "node.updated",
        driver,
        node: {
          id: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind,
          status,
          countsForRun: false,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: ref(nativeId),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        },
      });

    const emitText = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      data: {
        readonly assistantMessageID: string;
        readonly ordinal: number;
        readonly text?: string;
      },
      kind: "text" | "reasoning",
      update: (current: string) => string,
      completed = "text" in data,
    ) {
      const nativeId = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
      const updatedAt = yield* DateTime.now;
      const entry = turn.texts.get(nativeId) ?? {
        block: data,
        kind,
        startedAt: updatedAt,
        text: "",
      };
      entry.text = update(entry.text);
      if (completed) turn.texts.delete(nativeId);
      else turn.texts.set(nativeId, entry);
      if (entry.text.length === 0) return;
      const status = completed ? "completed" : "running";
      const completedAt = completed ? updatedAt : null;
      const nodeKind = kind === "text" ? "assistant_message" : "reasoning";
      yield* emitNode(state, turn, nativeId, nodeKind, status, entry.startedAt, completedAt);
      const base = itemBase(state, turn, nativeId, status, entry.startedAt, completedAt, updatedAt);
      if (kind === "reasoning") {
        yield* emit({
          type: "turn_item.updated",
          driver,
          turnItem: { ...base, type: "reasoning", text: entry.text, streaming: !completed },
        });
        return;
      }
      const messageId = idAllocator.derive.messageFromProviderItem({
        driver,
        nativeItemId: nativeId,
      });
      const message: OrchestrationV2ConversationMessage = {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: base.nodeId,
        role: "assistant",
        text: entry.text,
        attachments: [],
        streaming: !completed,
        createdAt: entry.startedAt,
        updatedAt,
      };
      yield* emit({ type: "message.updated", driver, message });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...base,
          type: "assistant_message",
          messageId,
          text: entry.text,
          streaming: !completed,
        },
      });
    });

    const emitTool = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      id: string,
      status: "running" | "completed" | "failed" | "interrupted",
      result?: { readonly output: string | undefined; readonly metadata: unknown },
    ) {
      const tool = turn.tools.get(id);
      if (tool === undefined) return;
      const updatedAt = yield* DateTime.now;
      const startedAt = turn.startedAt.get(id) ?? updatedAt;
      const completedAt = status === "running" ? null : updatedAt;
      const nativeId = `${turn.scope}${id}`;
      yield* emitNode(state, turn, nativeId, "tool_call", status, startedAt, completedAt);
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: openCodeToolTurnItem(
          itemBase(state, turn, nativeId, status, startedAt, completedAt, updatedAt),
          {
            name: tool.name,
            input: tool.input,
            output: result?.output,
            completedMetadata: status === "completed" ? result?.metadata : undefined,
          },
        ),
      });
    });

    const emitCompaction = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      status: "running" | "completed" | "failed" | "interrupted",
      summary?: string,
    ) {
      const compaction = turn.compaction;
      if (compaction === undefined) return;
      const updatedAt = yield* DateTime.now;
      const completedAt = status === "running" ? null : updatedAt;
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          ...itemBase(
            state,
            turn,
            compaction.nativeId,
            status,
            compaction.startedAt,
            completedAt,
            updatedAt,
          ),
          nodeId: turn.input.rootNodeId,
          type: "compaction",
          driver,
          title:
            status === "running"
              ? "Compacting context"
              : status === "completed"
                ? "Context compacted"
                : status === "failed"
                  ? "Compaction failed"
                  : "Compaction interrupted",
          ...(summary === undefined || summary.length === 0 ? {} : { summary }),
        },
      });
      if (status !== "running") turn.compaction = undefined;
    });

    const emitRetry = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      status: "running" | TurnTerminal["status"],
      failure?: OrchestrationV2ProviderFailure,
    ) {
      const retry = turn.retry;
      if (retry === undefined) return;
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: makeProviderRetryTurnItem({
          driver,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId: turn.input.rootNodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          itemOrdinal: ordinalOf(turn, `terminal-failure:${turn.providerTurn.id}`),
          failure: failure ?? retry.failure,
          retry: retry.retry,
          status,
          startedAt: retry.startedAt,
          updatedAt: yield* DateTime.now,
        }),
      });
    });

    const updateRetry = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      { attempt, error }: Pick<EventOf<"session.retry.scheduled">["data"], "attempt" | "error">,
      delayMs: number,
    ) {
      turn.retry = {
        retry: {
          // OpenCode counts the first request as attempt 1, so its first retry is attempt 2.
          attempt: Math.max(1, attempt - 1),
          maxAttempts: null,
          retryDelayMs: Math.max(0, Math.trunc(delayMs)),
        },
        failure: makeProviderFailure({
          message: error.message,
          code: error.type,
          class: "provider_error",
          retryable: true,
        }),
        startedAt: turn.retry?.startedAt ?? (yield* DateTime.now),
      };
      yield* emitRetry(state, turn, "running");
    });

    const emitProviderTurn = (
      state: ThreadState,
      turn: ActiveTurn,
      providerTurn: OrchestrationV2ProviderTurn,
    ) => {
      state.providerTurns.set(String(providerTurn.id), providerTurn);
      return emit({
        type: "provider_turn.updated",
        driver,
        threadId: turn.input.threadId,
        providerTurn,
      });
    };

    const makeTurn = (
      owner: TurnOwner,
      providerTurn: OrchestrationV2ProviderTurn,
      options: { readonly scope: string; readonly awaitingStart: boolean },
    ): ActiveTurn => ({
      input: owner,
      providerTurn,
      texts: new Map(),
      tools: new Map(),
      startedAt: new Map(),
      ordinals: new Map(),
      nextOrdinal: providerTurn.ordinal * 100 + 1,
      usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      steps: 0,
      lastStep: undefined,
      before: undefined,
      compaction: undefined,
      compactions: 0,
      retry: undefined,
      interrupted: false,
      unsent: false,
      steers: new Set(),
      settledInbox: new Set(),
      heldEnd: undefined,
      awaitingStart: options.awaitingStart,
      scope: options.scope,
      usedSubagents: false,
    });

    const emitSubagent = Effect.fnUntraced(function* (call: SubagentCall) {
      const updatedAt = yield* DateTime.now;
      const { turn, state } = call;
      const nodeId = idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: call.nativeId,
      });
      const completedAt = isOrchestrationV2WorkActive(call.status)
        ? null
        : (call.completedAt ?? updatedAt);
      const childProviderThreadId = call.child?.providerThread.id ?? null;
      const childThreadId = call.child?.subagent?.appThread.id ?? null;
      yield* emit({
        type: "node.updated",
        driver,
        node: {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "subagent",
          status: call.status,
          countsForRun: false,
          providerThreadId: childProviderThreadId ?? state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: ref(call.nativeId),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: call.startedAt,
          completedAt,
        },
      });
      yield* emit({
        type: "subagent.updated",
        driver,
        subagent: {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: instanceId,
          providerThreadId: childProviderThreadId,
          childThreadId,
          nativeTaskRef: ref(call.nativeId),
          prompt: call.prompt,
          title: call.title,
          model: call.model,
          status: call.status,
          result: call.result,
          startedAt: call.startedAt,
          completedAt,
          updatedAt,
        },
      });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: call.nativeId }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: ref(call.nativeId),
          parentItemId: null,
          ordinal: call.ordinal,
          status: call.status,
          title: call.title,
          startedAt: call.startedAt,
          completedAt,
          updatedAt,
          type: "subagent",
          subagentId: nodeId,
          origin: "provider_native",
          driver,
          providerInstanceId: instanceId,
          childThreadId,
          prompt: call.prompt,
          result: call.result,
        },
      });
      yield* syncRoster(rootOf(call.state));
    });

    const syncRoster = Effect.fnUntraced(function* (state: ThreadState) {
      const roster = runningCalls(state)
        .filter((call) => call.background)
        .map((call) => ({
          taskId: call.nativeId,
          kind: "subagent" as const,
          ...(call.title?.trim() ? { description: call.title.trim() } : {}),
          ...(call.child?.subagent === undefined
            ? {}
            : { childThreadId: call.child.subagent.appThread.id }),
        }));
      const current = state.providerThread.pendingBackgroundTasks ?? [];
      if (
        current.length === roster.length &&
        current.every(
          (task, index) =>
            task.taskId === roster[index]?.taskId &&
            task.description === roster[index]?.description &&
            (task.kind === "subagent" ? task.childThreadId : undefined) ===
              roster[index]?.childThreadId,
        )
      ) {
        return;
      }
      state.providerThread = {
        ...state.providerThread,
        pendingBackgroundTasks: roster,
        updatedAt: yield* DateTime.now,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
    });

    const withReportedModel = (
      providerThread: OrchestrationV2ProviderThread,
      model: ModelRef | undefined,
    ): OrchestrationV2ProviderThread => {
      if (model === undefined) return providerThread;
      const modelSelection: ModelSelection = {
        instanceId,
        model: `${model.providerID}/${model.id}`,
        options: model.variant === undefined ? [] : [{ id: "variant", value: model.variant }],
      };
      if (
        providerThread.nativeMetadata?.modelSelection !== undefined &&
        modelSelectionsEqual(providerThread.nativeMetadata.modelSelection, modelSelection)
      )
        return providerThread;
      return {
        ...providerThread,
        nativeMetadata: { ...providerThread.nativeMetadata, modelSelection },
      };
    };

    const attachChild = Effect.fnUntraced(function* (call: SubagentCall, childId: string) {
      if (call.child !== undefined) return;
      const info = announced.get(childId);
      announced.delete(childId);
      const now = yield* DateTime.now;
      const nodeId = idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: call.nativeId,
      });
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver,
        nativeThreadId: childId,
        providerInstanceId: instanceId,
      });
      const providerThreadId = idAllocator.derive.providerThread({
        driver,
        nativeThreadId: childId,
        providerInstanceId: instanceId,
      });
      if (info?.model !== undefined) call.model = `${info.model.providerID}/${info.model.id}`;
      call.title = call.title ?? info?.title ?? null;
      const parentThread = call.turn.input.appThread;
      const appThread = makeSubagentChildThread({
        parentThread,
        childThreadId,
        parentNodeId: nodeId,
        activeProviderThreadId: providerThreadId,
        providerInstanceId: instanceId,
        modelSelection: {
          instanceId,
          model: call.model ?? call.turn.input.modelSelection.model,
        },
        title: subagentThreadTitle({
          parentTitle: parentThread.title,
          title: call.title,
          prompt: call.prompt,
          ordinal: call.ordinal,
        }),
        now,
        createdBy: "agent",
        creationSource: "provider",
      });
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: input.providerSessionId,
        appThreadId: childThreadId,
        ownerNodeId: nodeId,
        nativeThreadRef: ref(childId),
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const previous = threads.get(childId);
      // Called again while it runs, the subagent takes the prompt as a steer
      // and OpenCode reports that run once, for every call that joined it.
      if (previous?.active !== undefined) {
        call.joined = [...call.state.calls.values()].findLast(
          (candidate) =>
            candidate !== call && candidate.child === previous && candidate.joined === undefined,
        );
      }
      const subagent = {
        call,
        appThread,
        turns: previous?.subagent?.turns ?? 0,
        prompt: call.prompt,
        queued: undefined,
      };
      const child =
        previous ?? newThreadState(childId, providerThread, call.state.directory, subagent);
      child.subagent = subagent;
      child.model = info?.model ?? child.model;
      child.providerThread = withReportedModel(providerThread, child.model);
      child.directory = call.state.directory;
      child.agent = info?.agent ?? call.agent ?? child.agent;
      child.rules = info?.permissions ?? child.rules;
      threads.set(childId, child);
      childOwners.set(childId, rootOf(call.state));
      call.child = child;
      yield* emit({ type: "app_thread.created", driver, appThread });
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: child.providerThread,
      });
      yield* emitSubagent(call);
      // A session called again was not made now, so it may hold the rules of
      // a mode the thread has left. OpenCode applies a rules change to the
      // asks after it, so it gets the thread's as soon as its call names it.
      if (info === undefined) {
        yield* writeRules(child, rootOf(call.state).policy).pipe(
          Effect.timeout(REQUEST_REPLY_TIMEOUT),
          Effect.ignore({ log: true }),
        );
      }
    });

    const settleCall: (
      call: SubagentCall,
      status: OrchestrationV2Subagent["status"],
      result?: string,
    ) => Effect.Effect<void> = Effect.fnUntraced(function* (call, status, result) {
      if (!isOrchestrationV2WorkActive(call.status)) return;
      call.status = status;
      call.completedAt = yield* DateTime.now;
      if (result !== undefined) call.result = result;
      call.state.calls.delete(call.toolId);
      const child = call.child;
      if (child !== undefined) {
        for (const nested of Array.from(child.calls.values())) {
          if (nested.background && status !== "failed") continue;
          yield* settleCall(nested, status === "completed" ? "interrupted" : status);
        }
        if (child.active !== undefined && status !== "completed") {
          yield* finishTurn(child, { status: "interrupted" });
        }
        child.providerThread = {
          ...child.providerThread,
          status: "idle",
          updatedAt: call.completedAt,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver,
          providerThread: child.providerThread,
        });
      }
      yield* emitSubagent(call);
    });

    const startChildTurn = Effect.fnUntraced(function* (child: ThreadState) {
      const subagent = child.subagent;
      if (subagent === undefined || child.active !== undefined) return;
      subagent.turns += 1;
      const startedAt = yield* DateTime.now;
      const nativeTurnId = `${child.sessionId}:turn:${subagent.turns}`;
      const rootNodeId = idAllocator.derive.nodeFromProviderItem({
        driver,
        nativeItemId: `${nativeTurnId}:root`,
      });
      const providerTurn: OrchestrationV2ProviderTurn = {
        id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
        providerThreadId: child.providerThread.id,
        nodeId: rootNodeId,
        runAttemptId: null,
        nativeTurnRef: ref(nativeTurnId, "weak"),
        ordinal: subagent.turns,
        status: "running",
        startedAt,
        completedAt: null,
      };
      const turn = makeTurn(
        {
          appThread: subagent.appThread,
          threadId: subagent.appThread.id,
          runId: null,
          runOrdinal: subagent.call.turn.input.runOrdinal,
          rootNodeId,
          modelSelection: subagent.appThread.modelSelection,
          runtimePolicy: subagent.call.turn.input.runtimePolicy,
        },
        providerTurn,
        { scope: `${child.sessionId}:`, awaitingStart: false },
      );
      turn.before = subagent.queued;
      subagent.queued = undefined;
      child.active = turn;
      yield* emit({
        type: "node.updated",
        driver,
        node: {
          id: rootNodeId,
          threadId: turn.input.threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: false,
          providerThreadId: child.providerThread.id,
          providerTurnId: providerTurn.id,
          nativeItemRef: ref(nativeTurnId, "weak"),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt: null,
        },
      });
      yield* emitProviderTurn(child, turn, providerTurn);
      const prompt = subagent.prompt;
      subagent.prompt = undefined;
      if (prompt !== undefined && prompt.length > 0) {
        const nativeId = `${nativeTurnId}:prompt`;
        const artifacts = makeSubagentConversationArtifacts({
          messageId: idAllocator.derive.messageFromProviderItem({ driver, nativeItemId: nativeId }),
          senderThreadId: subagent.call.turn.input.threadId,
          turnItemId: idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId: nativeId,
          }),
          threadId: turn.input.threadId,
          rootNodeId,
          providerThreadId: child.providerThread.id,
          providerTurnId: providerTurn.id,
          nativeItemRef: ref(nativeId, "weak"),
          role: "user",
          text: prompt,
          ordinal: ordinalOf(turn, nativeId),
          now: startedAt,
        });
        yield* emit({ type: "message.updated", driver, message: artifacts.message });
        yield* emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
      }
    });

    const offerWake = Effect.fnUntraced(function* (state: ThreadState, wake: Wake) {
      const route = state.providerThread.appThreadId;
      if (route === null || wake.messageId === undefined) return;
      const notification = backgroundWorkNotification(wake.reports);
      yield* continuationRequests.offer({
        threadId: route,
        providerThreadId: state.providerThread.id,
        driver,
        detail: wake.detail,
        messageId: wake.messageId,
        ...(notification === null ? {} : { notification }),
        dispatchIfCurrent: (dispatch) =>
          wake.dropped ? Effect.succeed(Option.none()) : Effect.map(dispatch, Option.some),
      });
    });

    const finishTurn = Effect.fnUntraced(function* (
      state: ThreadState,
      terminal: TurnTerminal,
      threadDisposition: "reusable" | "broken" = "reusable",
    ) {
      const turn = state.active;
      if (turn === undefined) return;
      state.active = undefined;
      for (const inboxID of turn.steers) state.strandedSteers.add(inboxID);
      for (const entry of pending.values()) {
        const background = callsAbove(entry.sessionId).some((call) => call.background);
        if (
          entry.sessionId === state.sessionId ||
          (entry.turn === turn && !(background && terminal.status !== "failed"))
        ) {
          yield* settleRequest(entry, "cancelled");
        }
      }
      const completedAt = yield* DateTime.now;
      for (const open of turn.texts.values()) {
        yield* emitText(state, turn, open.block, open.kind, (text) => text, true);
      }
      for (const id of turn.tools.keys()) {
        yield* emitTool(
          state,
          turn,
          id,
          terminal.status === "completed" ? "completed" : "interrupted",
        );
      }
      for (const call of Array.from(state.calls.values())) {
        if (call.turn !== turn) continue;
        if (call.background && terminal.status !== "failed") continue;
        yield* settleCall(call, terminal.status === "completed" ? "completed" : terminal.status);
      }
      if (state.subagent !== undefined) {
        yield* emit({
          type: "node.updated",
          driver,
          node: {
            id: turn.input.rootNodeId,
            threadId: turn.input.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: turn.input.rootNodeId,
            kind: "root_turn",
            status: terminal.status,
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: turn.providerTurn.nativeTurnRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: turn.providerTurn.startedAt,
            completedAt,
          },
        });
      }
      yield* emitCompaction(state, turn, terminal.status === "failed" ? "failed" : "interrupted");
      yield* emitRetry(
        state,
        turn,
        terminal.status,
        terminal.status === "failed" ? terminal.failure : undefined,
      );
      const window = windowOf(turn.input.runtimePolicy.cwd, turn.input.modelSelection.model);
      const lastStep = turn.lastStep;
      yield* emitProviderTurn(state, turn, {
        ...turn.providerTurn,
        status: terminal.status,
        completedAt,
        turnTokenUsage: turnTokenUsage(turn, terminal.status),
        ...(lastStep === undefined
          ? {}
          : {
              tokenUsage: {
                usedTokens:
                  lastStep.input + lastStep.cache.read + lastStep.cache.write + lastStep.output,
                maxTokens: window ?? null,
                inputTokens: lastStep.input + lastStep.cache.read + lastStep.cache.write,
                cachedInputTokens: lastStep.cache.read,
                outputTokens: lastStep.output,
                reasoningOutputTokens: lastStep.reasoning,
                updatedAt: DateTime.formatIso(completedAt),
              },
            }),
      });
      // A subagent's session is its call's to settle: a turn there is runless,
      // and T3 has no terminal to wait on.
      if (state.subagent !== undefined) {
        const call = state.subagent.call;
        if (!call.background && terminal.status !== "completed") {
          yield* settleCall(call, terminal.status);
        }
        if (terminal.status === "failed") {
          // A background call is settled by the report its parent reads, and a
          // child that failed has no report to read: every call attached to it
          // has to end with the failure, or the background ones keep the thread
          // showing work that is gone. Which of them joined the child last
          // does not matter: a foreground call is one until it is marked
          // background, and the earlier background call outlives that window.
          for (const attached of callsAttachedTo(state)) {
            yield* settleCall(attached, terminal.status, terminal.failure.message);
          }
        }
        return;
      }
      state.providerThread = {
        ...state.providerThread,
        status: threadDisposition === "broken" ? "error" : "idle",
        updatedAt: completedAt,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
      const anyActive = [...threads.values()].some(
        (candidate) => candidate.subagent === undefined && candidate.active !== undefined,
      );
      yield* setSessionStatus(pending.size > 0 ? "waiting" : anyActive ? "running" : "ready", null);
      const base = {
        type: "turn.terminal" as const,
        driver,
        // After a native fork the session's own thread has a fresh id, and the
        // terminal must name the thread the start was recorded against.
        providerThreadId: turn.providerTurn.providerThreadId,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        threadDisposition,
      };
      yield* emit(
        terminal.status === "failed"
          ? {
              ...base,
              status: "failed",
              failure: terminal.failure,
              failureItemOrdinal: ordinalOf(turn, `terminal-failure:${turn.providerTurn.id}`),
              ...(turn.retry === undefined
                ? {}
                : { retry: turn.retry.retry, retryStartedAt: turn.retry.startedAt }),
            }
          : { ...base, status: terminal.status, failure: null },
      );
      // A spawned server lists its models lazily, so a window still unknown is
      // read again for the next turn, off this stream so it never delays one.
      if (window === undefined) {
        yield* Effect.forkIn(readModels(directoryOf(turn.input.runtimePolicy.cwd)), sessionScope);
      }
    });

    /**
     * Ends the turn a request T3 could not answer would block, and stops the
     * session: OpenCode waits on an unanswered request forever. The stopped
     * run's end is its own, not the next turn's.
     */
    const abandonRequest = Effect.fnUntraced(function* (state: ThreadState, reason: string) {
      yield* Effect.logWarning("Could not answer an OpenCode request; ending its turn.", {
        reason,
      });
      if (state.active === undefined) return;
      markUnsettled(state);
      yield* finishTurn(state, {
        status: "failed",
        failure: makeProviderFailure({
          message: "OpenCode is waiting on a request T3 Code couldn't answer.",
          class: "provider_error",
        }),
      });
      yield* client.session
        .interrupt({ sessionID: Session.ID.make(state.sessionId) })
        .pipe(Effect.timeout("2 seconds"), Effect.ignore({ log: true }));
    });

    const forgetRequest = Effect.fnUntraced(function* (entry: PendingRequest) {
      if (!pending.delete(entry.request.id)) return false;
      if (pending.size === 0 && session.status === "waiting") {
        yield* setSessionStatus("running", null);
      }
      return true;
    });

    /**
     * T3's own answers are only forgotten: the orchestrator already recorded them.
     */
    const settleRequest = Effect.fnUntraced(function* (
      entry: PendingRequest,
      status: "resolved" | "cancelled",
    ) {
      if (!(yield* forgetRequest(entry)) || entry.answering) return;
      const now = yield* DateTime.now;
      const itemStatus = status === "resolved" ? "completed" : "cancelled";
      yield* emit({
        type: "runtime_request.updated",
        driver,
        threadId: entry.turn.input.threadId,
        runtimeRequest: { ...entry.request, status, resolvedAt: now },
      });
      yield* emit({
        type: "node.updated",
        driver,
        node: { ...entry.node, status: itemStatus, completedAt: now },
      });
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: { ...entry.item, status: itemStatus, completedAt: now, updatedAt: now },
      });
    });

    const stopStaleRequest = (
      sessionId: string,
      native: { readonly type: "permission" | "form"; readonly id: string },
    ): Effect.Effect<void> =>
      native.type === "permission"
        ? client.permission
            .reply({
              sessionID: Session.ID.make(sessionId),
              requestID: Permission.ID.make(native.id),
              decision: "reject",
            })
            .pipe(
              Effect.catchTags(permissionGone),
              Effect.timeout(REQUEST_REPLY_TIMEOUT),
              Effect.ignore({ log: true }),
            )
        : client.session.form
            .cancel({ sessionID: sessionId, formID: Form.ID.make(native.id) })
            .pipe(
              Effect.catchTags(formGone),
              Effect.timeout(REQUEST_REPLY_TIMEOUT),
              Effect.ignore({ log: true }),
            );

    /**
     * Stops what a session still waits on when this runtime first loads it:
     * T3 shows none of those requests (a restart or a closed session expired
     * them), and OpenCode would wait on them forever.
     */
    const stopLeftoverRequests = Effect.fnUntraced(function* (state: ThreadState) {
      const sessionID = Session.ID.make(state.sessionId);
      const listed = yield* Effect.all([
        client.permission.list({ sessionID }),
        client.session.form.list({ sessionID }),
      ]).pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT), Effect.option);
      if (listed._tag === "None") {
        return yield* Effect.logWarning("Could not list an OpenCode session's open requests.");
      }
      const [permissions, forms] = listed.value;
      if (permissions.length === 0 && forms.length === 0) return;
      markUnsettled(state);
      for (const request of permissions) {
        yield* stopStaleRequest(state.sessionId, { type: "permission", id: request.id });
      }
      for (const form of forms) {
        yield* stopStaleRequest(state.sessionId, { type: "form", id: form.id });
      }
    });

    const showRequest = Effect.fnUntraced(function* (
      sessionId: string,
      native: PendingRequest["native"],
      body:
        | {
            readonly type: "approval_request";
            readonly requestKind: Extract<
              OrchestrationV2TurnItem,
              { type: "approval_request" }
            >["requestKind"];
            readonly prompt: string;
            readonly options: Extract<
              OrchestrationV2TurnItem,
              { type: "approval_request" }
            >["options"];
          }
        | {
            readonly type: "user_input_request";
            readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
          },
    ) {
      const target = requestTurn(sessionId);
      if (target === undefined) return;
      const { state, turn } = target;
      if ([...pending.values()].some((entry) => entry.native.id === native.id)) return;
      const now = yield* DateTime.now;
      const requestId = yield* idAllocator.allocate.runtimeRequest({
        driver,
        providerTurnId: turn.providerTurn.id,
        nativeRequestId: native.id,
      });
      const nodeId = idAllocator.derive.approvalNode({ requestId });
      const request: OrchestrationV2RuntimeRequest = {
        id: requestId,
        nodeId,
        providerTurnId: turn.providerTurn.id,
        nativeRequestRef: ref(native.id),
        kind: body.type === "approval_request" ? body.requestKind : "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: input.providerSessionId },
        createdAt: now,
        resolvedAt: null,
      };
      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind: body.type,
        status: "waiting",
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(native.id),
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const base = {
        id: idAllocator.derive.approvalTurnItem({ requestId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(native.id),
        parentItemId: null,
        ordinal: ordinalOf(turn, native.id),
        status: "waiting" as const,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const item: OrchestrationV2TurnItem =
        body.type === "approval_request"
          ? {
              ...base,
              title: native.type === "permission" ? native.action : null,
              type: "approval_request",
              requestId,
              requestKind: body.requestKind,
              prompt: body.prompt,
              ...(body.options === undefined ? {} : { options: body.options }),
            }
          : {
              ...base,
              title: "User input",
              type: "user_input_request",
              requestId,
              questions: body.questions,
            };
      pending.set(requestId, {
        request,
        item,
        node,
        state,
        turn,
        sessionId,
        answering: false,
        native,
      });
      yield* emit({ type: "node.updated", driver, node });
      yield* emit({
        type: "runtime_request.updated",
        driver,
        threadId: turn.input.threadId,
        runtimeRequest: request,
      });
      yield* emit({ type: "turn_item.updated", driver, turnItem: item });
      yield* setSessionStatus("waiting", null);
    });

    const onPermissionAsked = Effect.fnUntraced(function* (data: Permission.Request) {
      const turn = threads.get(data.sessionID)?.active;
      const toolName =
        data.source === undefined ? undefined : turn?.tools.get(data.source.id)?.name;
      const save = data.save ?? [];
      yield* showRequest(
        data.sessionID,
        { type: "permission", id: data.id, action: data.action, resources: data.resources, save },
        {
          type: "approval_request",
          requestKind: openCodePermissionRequestKind(data.action, toolName),
          prompt: data.resources.length === 0 ? data.action : data.resources.join("\n"),
          options: [
            { decision: "cancel", label: "Cancel" },
            { decision: "decline", label: "Decline" },
            ...(save.length > 0
              ? [
                  {
                    decision: "acceptForSession" as const,
                    label: sessionGrantLabel(data.action, save),
                  },
                ]
              : []),
            { decision: "accept", label: "Approve" },
          ],
        },
      );
    });

    const onFormCreated = Effect.fnUntraced(function* (form: NativeForm) {
      const target = requestTurn(form.sessionID);
      if (target === undefined) return;
      const { state } = target;
      const mapped = formQuestions(form);
      if ("questions" in mapped) {
        return yield* showRequest(
          form.sessionID,
          { type: "form", id: form.id, form },
          { type: "user_input_request", questions: mapped.questions },
        );
      }
      // Cancelling ends OpenCode's execution as a user stop, so the turn is
      // failed here with the reason and that stop's end is skipped.
      yield* Effect.logWarning("Declined an OpenCode form T3 Code cannot show.", {
        reason: mapped.unsupported,
      });
      const cancelled = yield* deliver(
        client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }),
      );
      // The session that asked is the one blocked on the form and stopped by
      // its cancel: a subagent's own, whose parent reads its failed call and
      // goes on. A subagent's session has no Stop end to skip.
      const asker = threads.get(form.sessionID) ?? state;
      if (!cancelled) return yield* abandonRequest(asker, "form cancel failed");
      if (asker.subagent === undefined) markUnsettled(asker);
      yield* finishTurn(asker, {
        status: "failed",
        failure: makeProviderFailure({
          message: `OpenCode asked for ${mapped.unsupported}, which T3 Code can't show. The question was declined.`,
          class: "provider_error",
        }),
      });
    });

    const onAsked = Effect.fnUntraced(function* (
      asked:
        | { readonly type: "permission"; readonly request: Permission.Request }
        | { readonly type: "form"; readonly form: NativeForm },
    ) {
      const asking = asked.type === "permission" ? asked.request.sessionID : asked.form.sessionID;
      if (strays.has(asking)) {
        return yield* stopStaleRequest(
          asking,
          asked.type === "permission"
            ? { type: "permission", id: asked.request.id }
            : { type: "form", id: asked.form.id },
        );
      }
      const state = ownerOf(asking);
      if (state === undefined) return;
      const target = requestTurn(asking);
      if (target !== undefined && !target.turn.awaitingStart) {
        if (asked.type === "permission") return yield* onPermissionAsked(asked.request);
        return yield* onFormCreated(asked.form);
      }
      if (state.unsettled || state.active?.awaitingStart === true) {
        yield* stopStaleRequest(
          asking,
          asked.type === "permission"
            ? { type: "permission", id: asked.request.id }
            : { type: "form", id: asked.form.id },
        );
      }
    });

    const sessionOfEvent = (event: OpenCode2Client.OpenCode2StreamEvent) =>
      event.type === "unreadable.execution.ended" || event.type === "unreadable.execution.started"
        ? event.sessionID
        : "sessionID" in event.data && typeof event.data.sessionID === "string"
          ? event.data.sessionID
          : undefined;

    const executionEnd = (type: string) =>
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted";

    const startCall = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      toolId: string,
    ) {
      const nativeId = `${turn.scope}${toolId}`;
      const call: SubagentCall = {
        toolId,
        nativeId,
        state,
        turn,
        ordinal: ordinalOf(turn, nativeId),
        startedAt: yield* DateTime.now,
        prompt: "",
        title: null,
        agent: undefined,
        model: null,
        background: false,
        joined: undefined,
        child: undefined,
        status: "running",
        result: null,
        completedAt: null,
      };
      turn.usedSubagents = true;
      state.calls.set(toolId, call);
      yield* emitSubagent(call);
    });

    const onTurnEvent = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      event: OpenCode2Client.OpenCode2StreamEvent,
    ) {
      // OpenCode sends nothing when a retry goes through; the provider's first output marks it.
      if (
        turn.retry !== undefined &&
        (event.type === "session.text.started" ||
          event.type === "session.reasoning.started" ||
          event.type === "session.tool.input.started")
      ) {
        yield* emitRetry(state, turn, "completed");
        turn.retry = undefined;
      }
      switch (event.type) {
        case "session.text.started":
        case "session.reasoning.started":
        case "session.text.delta":
        case "session.reasoning.delta":
        case "session.text.ended":
        case "session.reasoning.ended": {
          const data = event.data;
          const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
          return yield* emitText(state, turn, data, kind, (text) =>
            "delta" in data ? text + data.delta : "text" in data ? data.text : text,
          );
        }
        case "session.tool.input.started":
          if (event.data.name === "question") return;
          if (event.data.name === "subagent") return yield* startCall(state, turn, event.data.id);
          turn.tools.set(event.data.id, { name: event.data.name, input: {} });
          turn.startedAt.set(event.data.id, yield* DateTime.now);
          return yield* emitTool(state, turn, event.data.id, "running");
        case "session.tool.called": {
          const call = state.calls.get(event.data.id);
          if (call !== undefined) {
            const { input } = event.data;
            call.prompt = stringField(input, "prompt") ?? call.prompt;
            call.title = stringField(input, "description") ?? call.title;
            call.agent = stringField(input, "agent");
            call.model = stringField(input, "model") ?? call.model;
            call.background = input["background"] === true;
            return yield* emitSubagent(call);
          }
          const tool = turn.tools.get(event.data.id);
          if (tool !== undefined) tool.input = event.data.input;
          return yield* emitTool(state, turn, event.data.id, "running");
        }
        case "session.tool.progress": {
          const call = state.calls.get(event.data.id);
          const childId = stringField(event.data.metadata, "sessionID");
          if (call !== undefined && childId !== undefined) yield* attachChild(call, childId);
          return;
        }
        case "session.tool.success": {
          const call = state.calls.get(event.data.id);
          if (call !== undefined) {
            const childId = stringField(event.data.metadata, "sessionID");
            if (childId !== undefined) yield* attachChild(call, childId);
            // A background call returns at launch, and so does one that joined a
            // background run; the report settles it.
            if (event.data.metadata?.["status"] === "running") {
              if (call.background) return;
              call.background = true;
              return yield* emitSubagent(call);
            }
            return yield* settleCall(call, "completed", subagentOutput(textOf(event.data.content)));
          }
          const output = textOf(event.data.content);
          yield* emitTool(state, turn, event.data.id, "completed", {
            output,
            metadata: event.data.metadata,
          });
          turn.tools.delete(event.data.id);
          return;
        }
        case "session.tool.failed": {
          const aborted = event.data.error.type === "aborted";
          const call = state.calls.get(event.data.id);
          if (call !== undefined) {
            return yield* settleCall(
              call,
              aborted ? "interrupted" : "failed",
              event.data.error.message,
            );
          }
          yield* emitTool(state, turn, event.data.id, aborted ? "interrupted" : "failed", {
            output: event.data.error.message,
            metadata: event.data.metadata,
          });
          turn.tools.delete(event.data.id);
          return;
        }
        case "session.compaction.started":
          turn.compaction = {
            nativeId: `${turn.providerTurn.id}:compaction:${turn.compactions++}`,
            startedAt: yield* DateTime.now,
          };
          return yield* emitCompaction(state, turn, "running");
        case "session.compaction.ended":
          return yield* emitCompaction(state, turn, "completed", event.data.text);
        case "session.compaction.failed":
          return yield* emitCompaction(state, turn, "failed");
        case "session.step.ended":
        case "session.step.failed": {
          const tokens = event.data.tokens;
          if (tokens === undefined) return;
          turn.steps += 1;
          turn.lastStep = tokens;
          turn.usage.input += tokens.input + tokens.cache.read + tokens.cache.write;
          turn.usage.cached += tokens.cache.read;
          turn.usage.cacheWrite += tokens.cache.write;
          turn.usage.output += tokens.output + tokens.reasoning;
          turn.usage.reasoning += tokens.reasoning;
          return;
        }
        case "session.retry.scheduled":
          return yield* updateRetry(state, turn, event.data, event.data.at - event.created);
        case "session.execution.started":
          turn.heldEnd = undefined;
          return;
        case "session.execution.succeeded":
          return yield* endExecution(state, turn, {
            status: turn.interrupted ? "interrupted" : "completed",
          });
        case "session.execution.interrupted":
          return yield* endExecution(state, turn, { status: "interrupted" });
        case "session.execution.failed":
          return yield* endExecution(state, turn, {
            status: "failed",
            failure: makeProviderFailure({
              message: event.data.error.message,
              code: event.data.error.type,
              class:
                event.data.error.type === "provider.quota" ||
                event.data.error.type === "provider.rate-limit"
                  ? "usage_limit"
                  : "provider_error",
            }),
          });
        default:
          return;
      }
    });

    const takeReports = Effect.fnUntraced(function* (state: ThreadState) {
      const delivered = [...state.reports.values()];
      state.reports.clear();
      const stopped =
        delivered.length > 0 &&
        delivered.every((entry) => state.stoppedChildren.has(entry.childId));
      for (const entry of delivered) state.stoppedChildren.delete(entry.childId);
      if (stopped) {
        markUnsettled(state);
        yield* client.session
          .interrupt({ sessionID: Session.ID.make(state.sessionId) })
          .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
      }
      return { delivered, stopped };
    });

    const onWake = Effect.fnUntraced(function* (state: ThreadState) {
      const { delivered, stopped } = yield* takeReports(state);
      if (stopped) return;
      const route = state.providerThread.appThreadId;
      const wake: Wake = {
        messageId:
          route === null
            ? undefined
            : yield* idAllocator.allocate.message({ threadId: route, ordinal: 0 }),
        events: [],
        running: true,
        reports: delivered.map((entry) => entry.report),
        detail: delivered.length === 0 ? null : delivered.map((entry) => entry.text).join("\n\n"),
        dropped: false,
        after: delivered.at(-1)?.inboxId,
        first: delivered[0]?.inboxId,
        children: new Set(),
      };
      state.wakes.push(wake);
      yield* Effect.logInfo("OpenCode started a turn on its own; asking for a continuation.", {
        providerThreadId: state.providerThread.id,
      });
      yield* offerWake(state, wake);
    });

    const onReport = Effect.fnUntraced(function* (
      state: ThreadState,
      inboxId: string,
      payload: {
        readonly text: string;
        readonly metadata?: Readonly<Record<string, unknown>> | undefined;
      },
    ) {
      const childId = stringField(payload.metadata, "childID");
      if (stringField(payload.metadata, "source") !== "subagent" || childId === undefined) return;
      strays.delete(childId);
      const call = [...state.calls.values()].find(
        (candidate) => candidate.child?.sessionId === childId,
      );
      const calls = [...state.calls.values()].filter(
        (candidate) => candidate === call || (call !== undefined && candidate.joined === call),
      );
      const outcome = reportOutcome(stringField(payload.metadata, "state"));
      state.reports.set(inboxId, {
        inboxId,
        childId,
        text: payload.text,
        report: {
          kind: "subagent",
          label: call?.title ?? stringField(payload.metadata, "description"),
          childThreadId: call?.child?.subagent?.appThread.id,
          outcome,
        },
      });
      const status = state.stoppedChildren.has(childId)
        ? "interrupted"
        : outcome === "failed"
          ? "failed"
          : outcome === "cancelled"
            ? "cancelled"
            : "completed";
      for (const each of calls) yield* settleCall(each, status, subagentOutput(payload.text));
    });

    const holderOf = (sessionId: string) => {
      const own = threads.get(sessionId);
      if (own !== undefined) return own.wakes.at(-1)?.running === true ? own : undefined;
      const parent = announced.get(sessionId)?.parentID;
      const holder = parent === undefined ? undefined : threads.get(parent);
      return holder !== undefined && holder.active === undefined && holder.wakes.length > 0
        ? holder
        : undefined;
    };

    /**
     * Ends the turn with its execution, unless a steer sent into it is still
     * undelivered: OpenCode then starts another execution for it, which the
     * turn owns too. A Stop leaves steers undelivered and starts nothing.
     */
    const endExecution = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      end: TurnTerminal,
    ) {
      if (end.status === "completed" && turn.steers.size > 0) {
        turn.heldEnd = end;
        return;
      }
      yield* finishTurn(state, end);
    });

    const endIfSettled = (state: ThreadState, turn: ActiveTurn) =>
      turn.heldEnd !== undefined && turn.steers.size === 0
        ? finishTurn(state, turn.heldEnd)
        : Effect.void;

    const handleEvent = Effect.fnUntraced(function* (event: OpenCode2Client.OpenCode2StreamEvent) {
      const sessionId = sessionOfEvent(event);
      const cleared = sessionId === undefined ? undefined : clearing.get(sessionId);
      if (cleared !== undefined) {
        if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
          return yield* Deferred.succeed(cleared, undefined);
        }
        if (
          event.type === "session.execution.started" ||
          event.type === "unreadable.execution.started"
        ) {
          return;
        }
      }
      if (sessionId !== undefined) {
        if (
          event.type === "session.execution.started" ||
          event.type === "unreadable.execution.started"
        ) {
          // A session runs one execution at a time, each opening with `started`
          // on this ordered stream. Once the run `unsettled` waits on has
          // started, a later start means that run is over: an end not seen by
          // now was lost with a dropped stream, and the next end is this
          // execution's own.
          const state = threads.get(sessionId);
          if (state?.unsettled === true) {
            if (state.unsettledStarted) state.unsettled = false;
            else state.unsettledStarted = true;
          }
          busy.add(sessionId);
        } else if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
          busy.delete(sessionId);
        }
      }
      if (event.type === "session.created" && event.data.parentID !== undefined) {
        const strayCaller = strays.get(event.data.parentID);
        if (strayCaller !== undefined) {
          strays.set(event.data.sessionID, strayCaller);
          return;
        }
        const owner = ownerOf(event.data.parentID);
        if (owner !== undefined) {
          childOwners.set(event.data.sessionID, owner);
          announced.set(event.data.sessionID, event.data);
          holderOf(event.data.parentID)?.wakes.at(-1)?.children.add(event.data.sessionID);
        }
        return;
      }
      const holder = sessionId === undefined ? undefined : holderOf(sessionId);
      const held = holder?.wakes.at(-1);
      if (holder !== undefined && held !== undefined) {
        held.events.push(event);
        if (
          sessionId === holder.sessionId &&
          (event.type === "unreadable.execution.ended" || executionEnd(event.type))
        ) {
          held.running = false;
        }
        return;
      }
      return yield* route(event, sessionId);
    });

    const route = Effect.fnUntraced(function* (
      event: OpenCode2Client.OpenCode2StreamEvent,
      sessionId: string | undefined,
      held = false,
    ) {
      const ended =
        !held && (event.type === "unreadable.execution.ended" || executionEnd(event.type))
          ? threads.get(sessionId ?? "")
          : undefined;
      if (ended?.unsettled === true) {
        ended.unsettled = false;
        return;
      }
      if (event.type === "unreadable.execution.started") {
        const turn = threads.get(event.sessionID)?.active;
        if (turn !== undefined) {
          turn.awaitingStart = false;
          turn.heldEnd = undefined;
          return;
        }
      }
      if (event.type === "unreadable.execution.ended") {
        const state = threads.get(event.sessionID);
        const turn = state?.active;
        if (state === undefined || turn === undefined || turn.awaitingStart) return;
        return yield* endExecution(
          state,
          turn,
          event.executionType === "session.execution.succeeded"
            ? { status: turn.interrupted ? "interrupted" : "completed" }
            : event.executionType === "session.execution.interrupted"
              ? { status: "interrupted" }
              : {
                  status: "failed",
                  failure: makeProviderFailure({
                    message: "OpenCode ended the turn with an error this version cannot read.",
                    class: "provider_error",
                  }),
                },
        );
      }
      if (event.type === "permission.asked") {
        return yield* onAsked({ type: "permission", request: event.data });
      }
      if (event.type === "form.created")
        return yield* onAsked({ type: "form", form: event.data.form });
      if (
        event.type === "permission.replied" ||
        event.type === "form.replied" ||
        event.type === "form.cancelled"
      ) {
        const nativeId = event.type === "permission.replied" ? event.data.requestID : event.data.id;
        const entry = [...pending.values()].find((candidate) => candidate.native.id === nativeId);
        if (entry === undefined || entry.answering) return;
        const answered =
          event.type === "form.replied" ||
          (event.type === "permission.replied" && event.data.reply !== "reject");
        return yield* settleRequest(entry, answered ? "resolved" : "cancelled");
      }
      if (sessionId === undefined) return;
      const state = threads.get(sessionId);
      if (state === undefined) return;
      if (event.type === "session.model.selected" || event.type === "session.step.started") {
        if (event.type === "session.model.selected") state.model = event.data.model;
        const providerThread = withReportedModel(state.providerThread, event.data.model);
        if (providerThread !== state.providerThread) {
          state.providerThread = { ...providerThread, updatedAt: yield* DateTime.now };
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: state.providerThread,
          });
        }
      }
      if (
        event.type === "session.inbox.enqueued" &&
        state.subagent !== undefined &&
        state.active === undefined
      ) {
        state.subagent.queued ??= event.data.inboxID;
      }
      if (event.type === "session.inbox.enqueued" && event.data.item.type === "synthetic") {
        return yield* onReport(state, event.data.inboxID, event.data.item.payload);
      }
      if (event.type === "session.inbox.cancelled" || event.type === "session.inbox.delivered") {
        state.reports.delete(event.data.inboxID);
        const turn = state.active;
        if (turn !== undefined && turn.steers.delete(event.data.inboxID)) {
          turn.settledInbox.add(event.data.inboxID);
          if (event.type === "session.inbox.cancelled") yield* endIfSettled(state, turn);
        }
        return;
      }
      if (
        event.type === "session.inbox.enqueued" &&
        event.data.item.type === "user" &&
        state.subagent !== undefined &&
        state.subagent.prompt === undefined &&
        state.active === undefined
      ) {
        state.subagent.prompt = event.data.item.payload.text;
        return;
      }
      const started =
        event.type === "session.execution.started" || event.type === "unreadable.execution.started";
      if (state.subagent !== undefined && state.active === undefined && started) {
        if ((yield* takeReports(state)).stopped) {
          state.subagent.queued = undefined;
          return;
        }
        return yield* startChildTurn(state);
      }
      const turn = state.active;
      if (turn === undefined) {
        if (started && state.subagent === undefined) return yield* onWake(state);
        return;
      }
      if (turn.awaitingStart) {
        if (event.type === "session.execution.started") turn.awaitingStart = false;
        return;
      }
      return yield* onTurnEvent(state, turn, event);
    });

    // The stream is the only terminal signal, and it is volatile: events sent
    // while it is down are gone, and a restarted server never ends the
    // execution it lost.
    let streamFailure: string | undefined;
    let reconnected = yield* Deferred.make<void>();
    const failAll = Effect.fnUntraced(function* (message: string) {
      streamFailure = message;
      yield* Deferred.succeed(reconnected, undefined);
      for (const state of threads.values()) {
        const failure = makeProviderFailure({ message, class: "transport_error" });
        yield* finishTurn(state, { status: "failed", failure }, "broken");
      }
      for (const state of threads.values()) {
        for (const call of runningCalls(state)) yield* settleCall(call, "failed");
        for (const wake of state.wakes.splice(0)) wake.dropped = true;
        state.reports.clear();
      }
      yield* setSessionStatus("error", message);
      yield* Queue.end(events);
    });
    const backfill = Effect.fnUntraced(function* (sessionId: string, state: ThreadState) {
      const turn = state.active;
      if (turn === undefined) return undefined;
      const promptId = promptOf(turn.providerTurn);
      const { before } = turn;
      if (promptId === undefined && before === undefined) return undefined;
      const start = before !== undefined ? before : promptId;
      const read = yield* OpenCode2Client.paginate(
        { sessionID: Session.ID.make(sessionId), order: "desc" as const, limit: 50 },
        client.message.list,
      ).pipe(
        Stream.takeUntil((message) => message.id === start),
        Stream.runCollect,
      );
      // Without its start the history holds only earlier turns (the stream
      // dropped before the prompt landed): none of it is this turn's.
      const found = start === null || read.at(-1)?.id === start;
      if (!found) return undefined;
      const recent = before !== undefined && before !== null ? read.slice(0, -1) : read;
      const idle = recent.find((message) => message.type === "idle");
      const assistant = recent.find((message) => message.type === "assistant");
      if (assistant?.retry !== undefined) {
        // Snapshots omit when the retry was scheduled, so only its remaining delay is known.
        yield* updateRetry(
          state,
          turn,
          assistant.retry,
          DateTime.toEpochMillis(assistant.retry.at) - DateTime.toEpochMillis(yield* DateTime.now),
        );
      } else if (
        turn.retry !== undefined &&
        assistant !== undefined &&
        assistant.error === undefined &&
        assistant.content.length > 0
      ) {
        yield* emitRetry(state, turn, "completed");
        turn.retry = undefined;
      }
      for (const message of recent.toReversed()) {
        if (message.type !== "assistant" || state.active !== turn) continue;
        const ordinals = { text: 0, reasoning: 0 };
        for (const part of message.content) {
          if (part.type === "text" || part.type === "reasoning") {
            const block = { assistantMessageID: message.id, ordinal: ordinals[part.type]++ };
            yield* emitText(state, turn, block, part.type, () => part.text, true);
            continue;
          }
          if (part.type !== "tool") continue;
          if (!turn.tools.has(part.id)) {
            turn.tools.set(part.id, { name: part.name, input: {} });
            turn.startedAt.set(part.id, yield* DateTime.now);
          }
          const tool = turn.tools.get(part.id)!;
          if (typeof part.state.input === "object" && part.state.input !== null) {
            tool.input = part.state.input as Record<string, unknown>;
          }
          if (part.state.status === "completed") {
            yield* emitTool(state, turn, part.id, "completed", {
              output: textOf(part.state.content),
              metadata: part.state.metadata,
            });
            turn.tools.delete(part.id);
          } else if (part.state.status === "error") {
            yield* emitTool(state, turn, part.id, "failed", {
              output: part.state.error.message,
              metadata: part.state.metadata,
            });
            turn.tools.delete(part.id);
          } else {
            yield* emitTool(state, turn, part.id, "running");
          }
        }
      }
      return idle === undefined ? undefined : { outcome: idle.outcome };
    });

    /**
     * A restarted server writes no such item for the execution it lost, and `session.outcome` is
     * still the previous execution's, so no `idle` means the turn was interrupted.
     */
    const reconcile = Effect.gen(function* () {
      // A subagent's turn ends before the turn that waits on it, so the
      // deepest sessions are read back first.
      const running = [...threads]
        .filter(([, state]) => state.active !== undefined)
        .toSorted(([left], [right]) => callsAbove(right).length - callsAbove(left).length);
      const background = [...threads.values()].filter(
        (state) => state.subagent === undefined && hasBackground(state),
      );
      const marked = [...threads.values()].some((state) => state.unsettled);
      if (
        running.length === 0 &&
        background.length === 0 &&
        busy.size === 0 &&
        !marked &&
        strays.size === 0
      ) {
        return;
      }
      const active = yield* client.session.active();
      for (const sessionId of busy) if (!(sessionId in active)) busy.delete(sessionId);
      for (const state of threads.values()) {
        if (state.unsettled && !(state.sessionId in active)) state.unsettledStarted = true;
      }
      for (const childId of strays.keys()) if (!(childId in active)) strays.delete(childId);
      for (const [sessionId, state] of running) {
        const turn = state.active;
        if (turn === undefined) continue;
        const ended = yield* backfill(sessionId, state);
        if (sessionId in active || state.active !== turn) continue;
        yield* finishTurn(
          state,
          ended?.outcome === "succeeded"
            ? { status: turn.interrupted ? "interrupted" : "completed" }
            : ended?.outcome === "failed"
              ? {
                  status: "failed",
                  failure: makeProviderFailure({
                    message:
                      "OpenCode ended the turn with an error while T3 Code was reconnecting.",
                    class: "provider_error",
                  }),
                }
              : { status: "interrupted" },
        );
      }
      for (const state of background) {
        for (const call of runningCalls(state)) {
          const child = call.child?.sessionId;
          if (child === undefined || !(child in active)) {
            yield* settleCall(call, "interrupted", LOST_BACKGROUND);
          }
        }
        for (const session of sessionsOf(state)) {
          discardWakes(session, session.wakes.splice(0));
          session.reports.clear();
        }
      }
      // Stopped off the lock this reconcile holds; one still running waits for a Stop.
      for (const thread of new Set([...strays.values()].map(rootOf))) {
        yield* Effect.forkIn(stopStrays(thread), sessionScope);
      }
      const listed = new Map<string, Set<string>>();
      for (const sessionId of Object.keys(active)) {
        if (ownerOf(sessionId) === undefined) continue;
        const sessionID = Session.ID.make(sessionId);
        const [permissions, forms] = yield* Effect.all([
          client.permission.list({ sessionID }),
          client.session.form.list({ sessionID }),
        ]);
        listed.set(sessionId, new Set([...permissions, ...forms].map((request) => request.id)));
        const shown = new Set([...pending.values()].map((entry) => entry.native.id));
        for (const request of permissions) {
          if (!shown.has(request.id)) yield* onAsked({ type: "permission", request });
        }
        for (const form of forms) {
          if (!shown.has(form.id)) yield* onAsked({ type: "form", form });
        }
      }
      for (const entry of Array.from(pending.values())) {
        if (listed.get(entry.sessionId)?.has(entry.native.id) !== true) {
          yield* settleRequest(entry, "cancelled");
        }
      }
    });

    const reconnect = Effect.gen(function* () {
      // Returned on any failure, including the interrupt a closing session
      // sends a reconnect still in flight, so a spawned server can idle-stop.
      const scope = yield* Scope.make();
      const { next, stream } = yield* Effect.gen(function* () {
        const next = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
        return { next, stream: yield* next.events };
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      const previous = currentScope;
      connection = next;
      client = next.client;
      currentScope = scope;
      yield* Scope.close(previous, Exit.void);
      // A restarted server forgot T3's MCP servers; the next turn adds them again.
      for (const state of threads.values()) state.mcp = undefined;
      yield* lock.withPermit(reconcile).pipe(Effect.timeout(RECONCILE_TIMEOUT));
      return stream;
    }).pipe(
      Effect.retry({ times: RECONNECT_ATTEMPTS - 1, schedule: Schedule.spaced(RECONNECT_DELAY) }),
    );

    let currentScope = initial.scope;
    yield* Effect.addFinalizer(() => Scope.close(currentScope, Exit.void));
    const follow = (
      stream: Stream.Stream<OpenCode2Client.OpenCode2StreamEvent, unknown>,
    ): Effect.Effect<void> =>
      stream.pipe(
        Stream.runForEach((event) => lock.withPermit(handleEvent(event))),
        Effect.exit,
        Effect.flatMap(() =>
          Effect.gen(function* () {
            streamFailure = "The OpenCode event stream was lost. Reconnecting.";
            yield* Effect.logWarning("Lost the OpenCode event stream; reconnecting.");
            // The last failure is kept for the log: it can carry the server's
            // URL or response text, so only its tag is annotated and the full
            // failure stays in the log's cause.
            const next = yield* reconnect.pipe(
              Effect.tapCause((cause) =>
                Effect.logWarning(
                  "Could not reconnect to the OpenCode event stream; failing the session.",
                  cause,
                ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
              ),
              Effect.option,
            );
            if (next._tag === "None") {
              return yield* failAll("The OpenCode event stream was lost and could not reconnect.");
            }
            streamFailure = undefined;
            const done = reconnected;
            reconnected = yield* Deferred.make<void>();
            yield* Deferred.succeed(done, undefined);
            return yield* follow(next.value);
          }),
        ),
      );
    // Subscribed before any session or prompt call, so no event of theirs is missed.
    yield* follow(yield* connection.events).pipe(Effect.forkScoped);

    // A server T3 did not start keeps running after T3 stops, so stop the turns
    // it would otherwise finish unseen. A spawned server stops with its owner.
    if (connection.external) {
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          [...threads].filter(([, state]) => state.active !== undefined),
          ([sessionId]) =>
            client.session
              .interrupt({ sessionID: Session.ID.make(sessionId) })
              .pipe(Effect.timeout("1 second"), Effect.ignore({ log: true })),
          { concurrency: 8, discard: true },
        ),
      );
    }

    const readModels = (directory: string) =>
      Effect.suspend(() => {
        const windows = contextWindows.get(directory) ?? new Map<string, number>();
        contextWindows.set(directory, windows);
        return client.model.list({ location: { directory } }).pipe(
          Effect.timeout("5 seconds"),
          Effect.tap((models) =>
            Effect.sync(() => {
              for (const model of models.data) {
                windows.set(
                  `${model.providerID}/${model.id}`,
                  model.limit.input ?? model.limit.context,
                );
              }
            }),
          ),
          Effect.ignore({ log: true }),
        );
      });
    const readModelsOnce = (cwd: string | null | undefined) =>
      contextWindows.has(directoryOf(cwd)) ? Effect.void : readModels(directoryOf(cwd));
    yield* readModels(session.cwd);

    const agentRules = new Map<string, ReadonlyMap<string, ReadonlyArray<Rule>>>();
    const pathsFor = Effect.fnUntraced(function* (
      directory: string,
      agents: ReadonlyArray<string>,
    ) {
      let known = agentRules.get(directory);
      if (known === undefined) {
        // A fresh server lists no agents for its first moments, like its models.
        const listed = yield* client.agent.list({ location: { directory } }).pipe(
          Effect.repeat({
            until: (list) => list.data.length > 0,
            schedule: Schedule.spaced("250 millis"),
          }),
          Effect.timeout("5 seconds"),
          Effect.tapCause((cause) =>
            Effect.logWarning(
              "Could not list OpenCode agents; their path rules are skipped.",
              cause,
            ).pipe(Effect.annotateLogs({ errorTag: causeErrorTag(cause) })),
          ),
          Effect.option,
        );
        if (listed._tag === "None") return [];
        known = new Map(
          listed.value.data.map((agent) => [agent.id, agentPaths(agent.permissions)]),
        );
        agentRules.set(directory, known);
      }
      const paths = new Map<string, Rule>();
      for (const agent of agents) {
        for (const entry of known.get(agent) ?? []) {
          paths.set(`${entry.action}\u0000${entry.resource}`, entry);
        }
      }
      return [...paths.values()];
    });

    const rulesFor = Effect.fnUntraced(function* (
      thread: Pick<ThreadState, "directory" | "agent" | "grants">,
      policy: RulesPolicy,
      appThreadId: string | null,
    ) {
      const plan = policy.interactionMode === "plan";
      const paths =
        policy.runtimeMode === "full-access" && !plan
          ? []
          : yield* pathsFor(thread.directory, plan ? [thread.agent, "plan"] : [thread.agent]);
      return sessionRules(
        policy,
        paths,
        policy.runtimeMode === "full-access" ? [] : thread.grants,
        appThreadId === null ? null : yield* mcpServerNameFor(appThreadId),
      );
    });

    const writeRules = Effect.fnUntraced(function* (state: ThreadState, policy: RulesPolicy) {
      const rules = yield* rulesFor(state, policy, rootOf(state).providerThread.appThreadId);
      if (!sameRules(state.rules, rules)) {
        yield* client.session.update({
          sessionID: Session.ID.make(state.sessionId),
          permissions: rules,
        });
        state.rules = rules;
      }
      state.policy = policy;
    });

    const writeTitle = Effect.fnUntraced(function* (state: ThreadState, title: string) {
      const next = title.trim();
      // An empty title asks OpenCode to generate one.
      if (next === "" || next === state.title) return;
      yield* client.session.update({ sessionID: Session.ID.make(state.sessionId), title: next });
      state.title = next;
    });

    const register = (
      providerThread: OrchestrationV2ProviderThread,
      native: {
        readonly id: string;
        readonly model?: ModelRef | undefined;
        readonly agent?: string | undefined;
        readonly title?: string | undefined;
        readonly permissions?: ReadonlyArray<Rule> | undefined;
      },
      directory: string,
    ) => {
      providerThread = withReportedModel(providerThread, native.model);
      const existing = threads.get(native.id);
      if (existing !== undefined) {
        existing.providerThread = providerThread;
        existing.model = native.model;
        existing.directory = directory;
        existing.agent = native.agent ?? existing.agent;
        existing.title = native.title;
        existing.rules = native.permissions;
        return existing;
      }
      const state = newThreadState(native.id, providerThread, directory, undefined);
      state.model = native.model;
      state.agent = native.agent ?? state.agent;
      state.title = native.title;
      state.rules = native.permissions;
      threads.set(native.id, state);
      return state;
    };

    /**
     * A rollback also waits for background subagents, whose reports wake the
     * session into the history it would cut.
     */
    const ensureQuiet = Effect.fnUntraced(function* (
      sessionId: string,
      verb: "roll back" | "fork",
    ) {
      const state = threads.get(sessionId);
      const busyHere =
        state !== undefined &&
        (state.active !== undefined ||
          busy.has(sessionId) ||
          (verb === "roll back" && hasBackground(state)));
      const busyThere =
        !busyHere &&
        (state === undefined || state.unsettled) &&
        sessionId in (yield* client.session.active().pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT)));
      if (busyHere || busyThere) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `Cannot ${verb} OpenCode session ${sessionId} while it is still working`,
        });
      }
    });

    const cancelStrandedSteers = Effect.fnUntraced(function* (state: ThreadState) {
      const sessionID = Session.ID.make(state.sessionId);
      for (const inboxID of Array.from(state.strandedSteers)) {
        const cancelled = yield* client.session.inbox
          .cancel({ sessionID, inboxID: SessionMessage.ID.make(inboxID) })
          .pipe(
            Effect.timeout(REQUEST_REPLY_TIMEOUT),
            Effect.tapCause((cause) =>
              Effect.logWarning("Could not take back an OpenCode steer.", cause),
            ),
            Effect.exit,
            Effect.map(Exit.isSuccess),
          );
        if (cancelled) state.strandedSteers.delete(inboxID);
      }
    });

    /**
     * Clears a staged revert and waits out the empty execution `clear` runs,
     * which is no turn of T3's. 2.0.18 wakes the session after every clear,
     * with or without a stage (seen live), so that execution always comes.
     */
    const clearRevert = Effect.fnUntraced(function* (sessionId: string) {
      const settled = yield* Deferred.make<void>();
      clearing.set(sessionId, settled);
      yield* client.session.revert
        .clear({ sessionID: Session.ID.make(sessionId) })
        .pipe(
          Effect.andThen(Deferred.await(settled)),
          Effect.timeout(REQUEST_REPLY_TIMEOUT),
          Effect.ensuring(Effect.sync(() => clearing.delete(sessionId))),
        );
      stagedReverts.delete(sessionId);
    });

    /**
     * If either fails or is interrupted the stage is cleared, since OpenCode commits a staged
     * revert on the next prompt; a clear that fails too is tried again before that prompt. Files
     * stay where they are: T3 restores its own checkpoint when the user asked for files, and a
     * rewind without files must not touch them.
     */
    const rollBackTo = Effect.fnUntraced(function* (
      sessionId: string,
      boundary: SessionMessage.ID,
    ) {
      const sessionID = Session.ID.make(sessionId);
      // Each step is bounded: a server that never answers would otherwise
      // hold the session's gate, and the next turn with it.
      yield* client.session.revert.stage({ sessionID, messageID: boundary, files: false }).pipe(
        Effect.timeout(REQUEST_REPLY_TIMEOUT),
        Effect.andThen(
          client.session.revert.commit({ sessionID }).pipe(Effect.timeout(REQUEST_REPLY_TIMEOUT)),
        ),
        Effect.onError(() =>
          clearRevert(sessionId).pipe(
            Effect.tapError(() => Effect.sync(() => stagedReverts.add(sessionId))),
            Effect.ignore({ log: true }),
          ),
        ),
      );
    });

    /**
     * The list takes one type, so it reads all.
     */
    const userMessages = (sessionId: string) =>
      OpenCode2Client.paginate(
        { sessionID: Session.ID.make(sessionId), limit: 100 },
        client.message.list,
      ).pipe(
        Stream.runCollect,
        Effect.map(
          (messages) =>
            new Set(
              messages.flatMap((message) =>
                message.type === "user" || message.type === "synthetic" ? [String(message.id)] : [],
              ),
            ),
        ),
      );

    const snapshotOf = Effect.fnUntraced(function* (
      providerThread: OrchestrationV2ProviderThread,
      sessionId: string,
    ) {
      const history = yield* OpenCode2Client.paginate(
        { sessionID: Session.ID.make(sessionId), order: "asc" as const, limit: 100 },
        client.message.list,
      ).pipe(Stream.runCollect);
      const snapshotAt = yield* DateTime.now;
      const messages = history.flatMap((message): Array<OrchestrationV2ConversationMessage> => {
        const text =
          message.type === "user"
            ? message.text
            : message.type === "assistant"
              ? textOf(message.content)
              : "";
        if (text.length === 0 || (message.type !== "user" && message.type !== "assistant")) {
          return [];
        }
        const createdAt = message.time.created;
        return [
          {
            createdBy: message.type === "user" ? "user" : "agent",
            creationSource: "provider",
            id: idAllocator.derive.messageFromProviderItem({
              driver,
              nativeItemId: message.id,
            }),
            threadId: providerThread.appThreadId ?? input.threadId,
            runId: null,
            nodeId: null,
            role: message.type,
            text,
            attachments: [],
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        ];
      });
      const lastUser = history.findLast((message) => message.type === "user")?.id;
      const state = threads.get(sessionId);
      return {
        providerThread: {
          ...providerThread,
          providerSessionId: input.providerSessionId,
          nativeConversationHeadRef: lastUser === undefined ? null : ref(lastUser, "weak"),
          status: "idle" as const,
          updatedAt: snapshotAt,
        },
        providerTurns: state === undefined ? [] : [...state.providerTurns.values()],
        messages,
        runtimeRequests: [],
      };
    });

    const promptText = Effect.fnUntraced(function* (
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      return (yield* providerMessageTextWithAttachmentPaths({
        text: turnInput.message.text,
        attachments: turnInput.message.attachments,
        resolveAttachmentPath: host.resolveAttachmentPath,
        resolveExtractedTextPath: host.resolveExtractedTextPath,
      })).trim();
    });

    const promptFiles = Effect.fnUntraced(function* (attachments: ReadonlyArray<ChatAttachment>) {
      const files: Array<{ uri: string; name: string }> = [];
      // An external server may not share T3's attachment directory.
      if (connection.external) return files;
      for (const attachment of attachments) {
        if (!isProviderNativeImageAttachment(attachment)) continue;
        const path = host.resolveAttachmentPath(attachment);
        if (path === null) continue;
        // OpenCode rejects the whole prompt if an attached file is missing.
        const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
        if (exists) files.push({ uri: NodeURL.pathToFileURL(path).href, name: attachment.name });
      }
      return files;
    });

    const removeMcp = (mcp: { readonly name: string; readonly directory: string }) =>
      Effect.suspend(() =>
        client.mcp.remove({ server: mcp.name, location: { directory: mcp.directory } }),
      ).pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true }));

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...threads.values()].flatMap((state) => (state.mcp === undefined ? [] : [state.mcp])),
        removeMcp,
        { concurrency: 8, discard: true },
      ),
    );

    const prepareTurn = Effect.fnUntraced(function* (
      sessionId: string,
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      const mcpSession = yield* mcpSessions.read(turnInput.threadId);
      const directory = turnInput.runtimePolicy.cwd ?? host.paths.cwd;
      const name = yield* mcpServerNameFor(turnInput.threadId);
      // An external server may not reach T3's MCP endpoint, as with 1.x.
      const wanted =
        mcpSession === undefined || connection.external
          ? undefined
          : { name, directory, credential: mcpSession.authorizationHeader };
      if (
        state.mcp !== undefined &&
        (wanted === undefined ||
          state.mcp.directory !== wanted.directory ||
          state.mcp.credential !== wanted.credential)
      ) {
        yield* removeMcp(state.mcp);
        state.mcp = undefined;
      }
      // Idle Location eviction drops runtime MCP servers without clearing T3's cache.
      // Re-adding an unchanged config keeps its existing connection.
      let mcpAvailable = false;
      if (wanted !== undefined) {
        mcpAvailable = yield* client.mcp
          .add({
            server: name,
            location: { directory },
            config: new Mcp.RemoteConfig({
              type: "remote",
              url: mcpSession!.endpoint,
              headers: { Authorization: wanted.credential },
              oauth: false,
            }),
          })
          .pipe(
            Effect.timeout(INVENTORY_TIMEOUT),
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not add T3 Code's MCP server to OpenCode.", cause).pipe(
                Effect.as(false),
              ),
            ),
          );
        if (mcpAvailable) state.mcp = wanted;
      }
      const instructions = [
        buildRuntimeInstructions({ harness: "OpenCode", model: turnInput.modelSelection.model }),
        t3OrchestrationSystemPrompt(mcpAvailable),
      ]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n\n");
      if (instructions !== state.instructions) {
        yield* client.session.instructions.entry.put({
          sessionID: Session.ID.make(sessionId),
          key: INSTRUCTIONS_KEY,
          value: instructions,
        });
        state.instructions = instructions;
      }
    });

    const markBefore = (sessionId: string, before: string | null) =>
      Effect.sync(() => {
        const turn = threads.get(sessionId)?.active;
        if (turn !== undefined) turn.before = before;
      });

    const beginTurn = Effect.fn("OpenCode2Adapter.beginTurn")(function* (
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      awaitingStart: boolean,
    ) {
      const startedAt = yield* DateTime.now;
      const nativeTurnId = `${state.sessionId}:attempt:${turnInput.attemptId}`;
      const providerTurn: OrchestrationV2ProviderTurn = {
        id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
        providerThreadId: turnInput.providerThread.id,
        nodeId: turnInput.rootNodeId,
        runAttemptId: turnInput.attemptId,
        nativeTurnRef: ref(
          isContinuation(turnInput)
            ? wakeTurnId(state.sessionId, turnInput.attemptId)
            : turnPromptId(state.sessionId, turnInput.attemptId),
          "weak",
        ),
        ordinal: turnInput.providerTurnOrdinal,
        status: "running",
        startedAt,
        completedAt: null,
      };
      const turn = makeTurn(turnInput, providerTurn, { scope: "", awaitingStart });
      if (streamFailure !== undefined) {
        return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
          driver,
          providerSessionId: input.providerSessionId,
          cause: streamFailure,
        });
      }
      state.active = turn;
      yield* emitProviderTurn(state, turn, providerTurn);
      state.providerThread = {
        ...state.providerThread,
        status: "active",
        firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
        lastRunOrdinal: turnInput.runOrdinal,
        updatedAt: startedAt,
      };
      yield* emit({
        type: "provider_thread.updated",
        driver,
        providerThread: state.providerThread,
      });
      yield* setSessionStatus("running", null);
      return turn;
    });

    const replay = Effect.fnUntraced(function* (wake: Wake) {
      wake.dropped = true;
      for (const event of wake.events) yield* route(event, sessionOfEvent(event), true);
    });

    const discardWakes = (caller: ThreadState, wakes: ReadonlyArray<Wake>) => {
      const retired = new Set<string>();
      const retire = (childId: string) => {
        const info = announced.get(childId);
        if (info === undefined) return;
        announced.delete(childId);
        childOwners.delete(childId);
        strays.set(childId, caller);
        retired.add(childId);
        threads.get(info.parentID ?? "")?.stoppedChildren.add(childId);
      };
      for (const wake of wakes) {
        wake.dropped = true;
        for (const childId of wake.children) retire(childId);
      }
      for (let grew = retired.size > 0; grew;) {
        grew = false;
        for (const [childId, info] of announced) {
          if (info.parentID === undefined || !retired.has(info.parentID)) continue;
          retire(childId);
          grew = true;
        }
      }
    };

    /**
     * Stops a thread's strays one by one, as a Stop stops background subagents, and never under
     * `lock`: one that does not answer would otherwise hold up every event.
     */
    const stopStrays = (thread: ThreadState) =>
      Effect.forEach(
        [...strays].flatMap(([childId, caller]) => (rootOf(caller) === thread ? [childId] : [])),
        (childId) =>
          client.session.interrupt({ sessionID: Session.ID.make(childId) }).pipe(
            Effect.asVoid,
            Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
            Effect.timeout(INTERRUPT_TIMEOUT),
            Effect.tap(() => Effect.sync(() => strays.delete(childId))),
            Effect.ignore({ log: true }),
          ),
        { discard: true },
      );

    /**
     * A user turn that starts while OpenCode runs an execution on its own: the
     * prompt joins that execution, so the turn takes it, and its continuation
     * turn is no longer needed.
     */
    const takeRunningWake = Effect.fnUntraced(function* (state: ThreadState) {
      const wake = state.wakes.at(-1);
      if (wake?.running !== true) return;
      state.wakes.pop();
      yield* replay(wake);
    });

    const runWake = Effect.fnUntraced(function* (
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      yield* beginTurn(state, turnInput, false);
      yield* lock.withPermit(
        Effect.gen(function* () {
          const index = state.wakes.findIndex(
            (held) => held.messageId === turnInput.message.messageId,
          );
          if (index < 0) return yield* finishTurn(state, { status: "completed" });
          // Queued continuations can't be reordered (they carry a notification),
          // so an earlier wake here lost its continuation to a cancel or a failed
          // dispatch. Dropping it keeps that wake from pinning the session.
          discardWakes(state, state.wakes.splice(0, index));
          yield* Effect.forkIn(stopStrays(state), sessionScope);
          const wake = state.wakes.shift()!;
          const turn = state.active;
          if (turn !== undefined && wake.after !== undefined) turn.before = wake.after;
          // Its first report is where its history begins, so fork and rollback cut there.
          if (turn !== undefined && wake.first !== undefined) {
            turn.providerTurn = { ...turn.providerTurn, nativeTurnRef: ref(wake.first, "weak") };
          }
          if (wake.running) state.unsettled = false;
          yield* replay(wake);
        }),
      );
    });

    const stopBackground = Effect.fnUntraced(function* (state: ThreadState) {
      const calls = runningCalls(state).filter((call) => call.background);
      const callers = sessionsOf(state);
      // A subagent whose call ended runs again when OpenCode wakes it to
      // answer a report of its own background subagent.
      const followUps = callers.filter(
        (caller) =>
          caller.subagent !== undefined &&
          busy.has(caller.sessionId) &&
          !isOrchestrationV2WorkActive(caller.subagent.call.status),
      );
      // OpenCode announces a child's session before the call's progress names
      // it, so a call without a child yet is stopped through its caller's
      // announced children.
      const announcedTo = (caller: ThreadState) =>
        [...announced.values()].flatMap((info) =>
          info.parentID === caller.sessionId ? [info.sessionID] : [],
        );
      const childrenOf = (call: SubagentCall) =>
        call.child === undefined ? announcedTo(call.state) : [call.child.sessionId];
      const children = new Map(
        calls.flatMap((call) => childrenOf(call).map((childId) => [childId, call.state] as const)),
      );
      const unreached = new Set<string>();
      for (const [childId, caller] of children) {
        caller.stoppedChildren.add(childId);
        const reached = yield* client.session
          .interrupt({ sessionID: Session.ID.make(childId) })
          .pipe(
            Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
            Effect.timeout(INTERRUPT_TIMEOUT),
            Effect.tapCause((cause) =>
              Effect.logWarning("Could not stop an OpenCode subagent.", cause),
            ),
            Effect.exit,
            Effect.map(Exit.isSuccess),
          );
        if (!reached) unreached.add(childId);
      }
      for (const followUp of followUps) {
        yield* client.session
          .interrupt({ sessionID: Session.ID.make(followUp.sessionId) })
          .pipe(
            Effect.catchTags({ SessionNotFoundError: () => Effect.void }),
            Effect.timeout(INTERRUPT_TIMEOUT),
            Effect.ignore({ log: true }),
          );
      }
      yield* lock.withPermit(
        Effect.gen(function* () {
          for (const call of calls) {
            if (childrenOf(call).some((childId) => unreached.has(childId))) continue;
            yield* settleCall(call, "interrupted");
          }
          for (const caller of callers) {
            for (const report of caller.reports.values()) {
              caller.stoppedChildren.add(report.childId);
            }
          }
          const running = state.wakes.some((wake) => wake.running);
          discardWakes(state, state.wakes.splice(0));
          if (running) {
            markUnsettled(state);
            yield* client.session
              .interrupt({ sessionID: Session.ID.make(state.sessionId) })
              .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
          }
        }),
      );
      yield* stopStrays(state);
    });

    const submit = Effect.fnUntraced(function* (
      sessionId: string,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      state: ThreadState,
      turn: ActiveTurn,
    ) {
      const sessionID = Session.ID.make(sessionId);
      const sending = () => {
        if (state.active !== turn || turn.interrupted) return false;
        turn.unsent = false;
        return true;
      };
      const text = turnInput.message.text.trim();
      const bare = turnInput.message.attachments.length === 0;
      const id = turnPromptId(sessionId, turnInput.attemptId);
      if (bare && text === "/compact") {
        if (!sending()) return;
        return yield* client.session.compact({ sessionID, id }).pipe(Effect.asVoid);
      }
      const location = { directory: turnInput.runtimePolicy.cwd ?? host.paths.cwd };
      const command = bare ? commandOf(text) : undefined;
      if (command !== undefined) {
        const commands = yield* client.command.list({ location }).pipe(
          Effect.timeout(INVENTORY_TIMEOUT),
          Effect.map((list) => list.data),
          Effect.orElseSucceed(() => []),
        );
        if (commands.some((entry) => entry.name === command.name)) {
          // `session.command` takes no id of T3's and its answer carries none,
          // so the turn remembers where the history stood before it.
          const newest = yield* client.message.list({ sessionID, order: "desc", limit: 1 });
          yield* markBefore(sessionId, newest.data[0]?.id ?? null);
          if (!sending()) return;
          return yield* client.session.command({ sessionID, ...command });
        }
      }
      const skills = SKILL_MENTION.test(text)
        ? skillsNamed(
            text,
            yield* client.skill.list({ location }).pipe(
              Effect.timeout(INVENTORY_TIMEOUT),
              Effect.map((list) => new Set(list.data.map((skill) => skill.id))),
              Effect.orElseSucceed(() => new Set<string>()),
            ),
          )
        : [];
      const files = yield* promptFiles(turnInput.message.attachments);
      const messageText = yield* promptText(turnInput);
      if (!sending()) return;
      return yield* client.session
        .prompt({
          sessionID,
          id,
          text: messageText,
          ...(files.length === 0 ? {} : { files }),
          ...(skills.length === 0
            ? {}
            : { skills: skills.map((id) => ({ id: Skill.ID.make(id) })) }),
        })
        .pipe(Effect.asVoid);
    });

    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId,
      driver,
      providerSessionId: input.providerSessionId,
      get providerSession() {
        return session;
      },
      events: Stream.fromQueue(events),
      // A background subagent keeps its session busy after its parent's turn,
      // and a held wake still needs its turn: idle release must wait for both.
      hasPendingBackgroundWork: Effect.sync(() => [...threads.values()].some(owesWork)),
      hasPendingBackgroundWorkForThread: (providerThread) =>
        Effect.sync(() => {
          const nativeId = providerThread.nativeThreadRef?.nativeId;
          const state = nativeId == null ? undefined : threads.get(nativeId);
          return state !== undefined && hasBackground(state);
        }),
      getModelContextWindow: (selection, cwd) =>
        selection.instanceId === instanceId
          ? windowOf(cwd === undefined ? session.cwd : cwd, selection.model)
          : undefined,
      ensureThread: Effect.fn("OpenCode2Adapter.ensureThread")(
        function* (threadInput) {
          if (threadInput.existingProviderThread?.nativeThreadRef != null) {
            return yield* runtime.resumeThread({
              providerThread: threadInput.existingProviderThread,
              threadId: threadInput.threadId,
              modelSelection: threadInput.modelSelection,
              runtimePolicy: threadInput.runtimePolicy,
            });
          }
          yield* readModelsOnce(threadInput.runtimePolicy.cwd);
          const model = modelRef(threadInput.modelSelection);
          if (model === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: malformedModel(threadInput.modelSelection.model),
            });
          }
          const directory = threadInput.runtimePolicy.cwd ?? host.paths.cwd;
          const policy = threadInput.runtimePolicy;
          const permissions = yield* rulesFor(
            { directory, agent: "build", grants: [] },
            policy,
            threadInput.threadId,
          );
          const title = threadInput.title?.trim() || undefined;
          // A session created with a title is never titled by OpenCode's own model.
          const created = yield* client.session.create({
            location: Location.PublicRef.make({ directory: AbsolutePath.make(directory) }),
            model,
            permissions,
            ...(title === undefined ? {} : { title }),
          });
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            ...(threadInput.existingProviderThread ?? {
              id: idAllocator.derive.providerThread({ driver, nativeThreadId: created.id }),
              driver,
              providerInstanceId: instanceId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
            }),
            providerSessionId: input.providerSessionId,
            nativeThreadRef: ref(created.id),
            nativeConversationHeadRef: null,
            status: "idle",
            updatedAt: createdAt,
          };
          const state = register(
            providerThread,
            {
              id: created.id,
              model: created.model,
              agent: created.agent,
              title: title ?? created.title,
              permissions,
            },
            directory,
          );
          state.policy = policy;
          return state.providerThread;
        },
        (effect, threadInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver,
                    threadId: threadInput.threadId,
                    cause,
                  }),
            ),
          ),
      ),
      resumeThread: Effect.fn("OpenCode2Adapter.resumeThread")(
        function* (threadInput) {
          const sessionId = yield* sessionIdOf(threadInput.providerThread);
          if (threadInput.runtimePolicy !== undefined) {
            yield* readModelsOnce(threadInput.runtimePolicy.cwd);
          }
          const native = yield* client.session.get({ sessionID: Session.ID.make(sessionId) });
          const providerThread: OrchestrationV2ProviderThread = {
            ...threadInput.providerThread,
            providerSessionId: input.providerSessionId,
            status: "idle",
            updatedAt: yield* DateTime.now,
          };
          const cwd = threadInput.runtimePolicy?.cwd;
          const loaded = threads.has(sessionId);
          const state = register(providerThread, native, cwd ?? native.location.directory);
          if (!loaded) yield* stopLeftoverRequests(state);
          yield* writeRules(state, threadInput.runtimePolicy ?? state.policy);
          if (cwd != null && native.location.directory !== cwd) {
            yield* client.session.move({
              sessionID: Session.ID.make(sessionId),
              directory: AbsolutePath.make(cwd),
            });
          }
          return state.providerThread;
        },
        (effect, threadInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
            ),
          ),
      ),
      compactThread: (turnInput) =>
        runtime.startTurn({ ...turnInput, message: { ...turnInput.message, text: "/compact" } }),
      startTurn: Effect.fn("OpenCode2Adapter.startTurn")(
        function* (turnInput) {
          // Waited out before the session's gate, so a rollback or fork is not
          // held behind a reconnect.
          if (streamFailure !== undefined) {
            yield* Deferred.await(reconnected).pipe(Effect.timeout(RECONNECT_WAIT), Effect.ignore);
          }
          if (streamFailure !== undefined) {
            return yield* new ProviderAdapter.ProviderAdapterEventStreamError({
              driver,
              providerSessionId: input.providerSessionId,
              cause: streamFailure,
            });
          }
          // Its checks and setup take the session's gate, so a rollback or
          // fork sees either no turn or this one installed; the prompt after
          // it does not hold the gate.
          const started = yield* exclusive(turnInput.providerThread)(
            Effect.gen(function* () {
              const sessionId = yield* sessionIdOf(turnInput.providerThread);
              const state = threads.get(sessionId);
              if (state === undefined) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: OPENCODE_PROVIDER,
                  detail: `OpenCode session ${sessionId} is not registered`,
                });
              }
              if (state.active !== undefined) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: OPENCODE_PROVIDER,
                  detail: `OpenCode session ${sessionId} already has an active turn`,
                  reason: "previous_turn_active",
                });
              }
              if (isContinuation(turnInput)) return yield* runWake(state, turnInput);
              const afterUnsettled = state.unsettled;
              let stillStopping = false;
              if (state.unsettled) {
                const active = yield* client.session
                  .active()
                  .pipe(Effect.timeout(ACTIVE_CHECK_TIMEOUT));
                stillStopping = sessionId in active;
                if (stillStopping) {
                  yield* client.session
                    .interrupt({ sessionID: Session.ID.make(sessionId) })
                    .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
                } else {
                  state.unsettled = false;
                }
              }
              const begin = beginTurn(state, turnInput, afterUnsettled);
              if (stillStopping) {
                yield* begin;
                return yield* finishTurn(state, {
                  status: "failed",
                  failure: makeProviderFailure({
                    message: OPENCODE_2_STILL_STOPPING,
                    class: "provider_error",
                  }),
                });
              }
              const model = modelRef(turnInput.modelSelection);
              if (model === undefined) {
                yield* begin;
                return yield* finishTurn(state, {
                  status: "failed",
                  failure: makeProviderFailure({
                    message: malformedModel(turnInput.modelSelection.model),
                    class: "validation_error",
                  }),
                });
              }
              // Plan mode is OpenCode's `plan` agent, switched before the rules are
              // written so they keep that agent's own path allows.
              const agent = agentFor(turnInput);
              if (agent !== state.agent) {
                yield* client.session.switchAgent({
                  sessionID: Session.ID.make(sessionId),
                  agent: Agent.ID.make(agent),
                });
                state.agent = agent;
              }
              // The thread's mode may have changed since the session was loaded,
              // and its subagents still running hold the rules they started with.
              // Those run on whether or not this turn starts, so theirs are best effort.
              yield* writeRules(state, turnInput.runtimePolicy);
              yield* writeTitle(state, turnInput.appThread.title).pipe(
                Effect.timeout(REQUEST_REPLY_TIMEOUT),
                Effect.ignore({ log: true }),
              );
              for (const call of runningCalls(state)) {
                if (call.child === undefined) continue;
                yield* writeRules(call.child, turnInput.runtimePolicy).pipe(
                  Effect.timeout(REQUEST_REPLY_TIMEOUT),
                  Effect.ignore({ log: true }),
                );
              }
              if (!sameModel(model, state.model)) {
                yield* client.session.switchModel({ sessionID: Session.ID.make(sessionId), model });
                state.model = model;
              }
              // Steers a stopped turn never delivered would reach the model first,
              // and a revert a failed rollback left staged would be committed.
              yield* cancelStrandedSteers(state);
              if (stagedReverts.has(sessionId)) yield* clearRevert(sessionId);
              yield* prepareTurn(sessionId, state, turnInput);
              const turn = yield* begin;
              turn.unsent = true;
              yield* lock.withPermit(takeRunningWake(state));
              return { state, sessionId, turn };
            }),
          );
          if (started === undefined) return;
          const { state, sessionId, turn } = started;
          yield* submit(sessionId, turnInput, state, turn).pipe(
            // Deleted outside T3: the thread is broken, and forgetting it makes
            // the next turn resume, fail, and recreate it with a handoff.
            Effect.catchTags({
              SessionNotFoundError: () =>
                finishTurn(
                  state,
                  {
                    status: "failed",
                    failure: makeProviderFailure({
                      message:
                        "The OpenCode session no longer exists. Send the message again to continue in a new session.",
                      class: "provider_error",
                    }),
                  },
                  "broken",
                ).pipe(Effect.andThen(Effect.sync(() => threads.delete(sessionId)))),
            }),
            Effect.tapError((cause) =>
              state.active === turn
                ? Effect.gen(function* () {
                    if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) markUnsettled(state);
                    yield* finishTurn(state, {
                      status: "failed",
                      failure: makeProviderFailure({ cause, class: "provider_error" }),
                    });
                  })
                : Effect.void,
            ),
          );
        },
        (effect, turnInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
            ),
          ),
      ),
      steerTurn: Effect.fn("OpenCode2Adapter.steerTurn")(
        function* (steerInput) {
          const sessionId = yield* sessionIdOf(steerInput.providerThread);
          const state = threads.get(sessionId);
          const turn = state?.active;
          if (
            state === undefined ||
            turn === undefined ||
            turn.providerTurn.id !== steerInput.providerTurnId ||
            turn.interrupted
          ) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode turn ${steerInput.providerTurnId} is not active`,
            });
          }
          const inboxID = steerPromptId(sessionId, steerInput.message.messageId);
          if (turn.settledInbox.has(inboxID)) return;
          turn.steers.add(inboxID);
          state.strandedSteers.delete(inboxID);
          const files = yield* promptFiles(steerInput.message.attachments);
          const messageText = (yield* providerMessageTextWithAttachmentPaths({
            text: steerInput.message.text,
            attachments: steerInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          })).trim();
          if (state.active !== turn || turn.interrupted) {
            yield* lock.withPermit(
              Effect.gen(function* () {
                turn.steers.delete(inboxID);
                // Stop may have stranded this steer, but it never reached OpenCode.
                state.strandedSteers.delete(inboxID);
                if (state.active === turn) {
                  if (turn.interrupted && turn.heldEnd !== undefined) {
                    turn.heldEnd = { status: "interrupted" };
                  }
                  yield* endIfSettled(state, turn);
                }
              }),
            );
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode turn ${steerInput.providerTurnId} is not active`,
            });
          }
          yield* client.session
            .prompt({
              sessionID: Session.ID.make(sessionId),
              id: inboxID,
              text: messageText,
              ...(files.length === 0 ? {} : { files }),
              delivery: "steer",
            })
            .pipe(
              Effect.tapError((cause) =>
                lock.withPermit(
                  Effect.gen(function* () {
                    turn.steers.delete(inboxID);
                    if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) state.strandedSteers.add(inboxID);
                    if (state.active === turn) yield* endIfSettled(state, turn);
                  }),
                ),
              ),
            );
        },
        (effect, steerInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptTurn: Effect.fn("OpenCode2Adapter.interruptTurn")(
        function* (interruptInput) {
          const sessionId = yield* sessionIdOf(interruptInput.providerThread);
          const state = threads.get(sessionId);
          if (state === undefined) return;
          const turn = state.active;
          // OpenCode stops a foreground subagent with its parent, but not a
          // background one: a user Stop (`requestRuntimeRestart`) stops those
          // too, and the execution OpenCode starts to report them. A turn
          // interrupted to restart it with new input leaves them running.
          if (interruptInput.requestRuntimeRestart === true) yield* stopBackground(state);
          if (turn === undefined || turn.providerTurn.id !== interruptInput.providerTurnId) {
            return;
          }
          turn.interrupted = true;
          const reply = yield* client.session
            .interrupt({ sessionID: Session.ID.make(sessionId) })
            .pipe(
              Effect.timeoutOption(INTERRUPT_TIMEOUT),
              Effect.tapError(() =>
                Effect.sync(() => {
                  turn.interrupted = false;
                }),
              ),
            );
          if (reply._tag === "None") {
            markUnsettled(state);
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          // Between the executions a late steer spans nothing runs yet. The
          // steers are taken back, and a run they already started is skipped.
          if (!reply.value.interrupted && state.active === turn && turn.heldEnd !== undefined) {
            markUnsettled(state);
            yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
            return yield* cancelStrandedSteers(state);
          }
          if (!reply.value.interrupted && state.active === turn && turn.unsent) {
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          if (!reply.value.interrupted && state.active === turn) {
            turn.interrupted = false;
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode session ${sessionId} had nothing running to stop`,
            });
          }
        },
        (effect, interruptInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterInterruptError({
                    driver,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      unloadThread: Effect.fn("OpenCode2Adapter.unloadThread")(function* ({ providerThread }) {
        const nativeId = providerThread.nativeThreadRef?.nativeId;
        const state = nativeId == null ? undefined : threads.get(nativeId);
        if (
          nativeId == null ||
          state === undefined ||
          state.active !== undefined ||
          hasBackground(state)
        ) {
          return;
        }
        threads.delete(nativeId);
        for (const [child, owner] of childOwners) {
          if (owner !== state) continue;
          childOwners.delete(child);
          threads.delete(child);
        }
        if (state.mcp !== undefined) yield* removeMcp(state.mcp);
      }),
      respondToRuntimeRequest: Effect.fn("OpenCode2Adapter.respondToRuntimeRequest")(
        function* (requestInput) {
          const entry = pending.get(requestInput.requestId);
          if (entry === undefined || entry.answering) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: `No pending OpenCode request ${requestInput.requestId}`,
            });
          }
          const { decision, answers } = requestInput;
          const { native } = entry;
          if (native.type === "permission" && decision === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: `OpenCode approval request ${requestInput.requestId} requires a decision`,
            });
          }
          entry.answering = true;
          // OpenCode's own "always" saves a grant for the whole project, so a
          // subagent's own, not its parent's.
          const asker = threads.get(entry.sessionId) ?? entry.state;
          if (
            native.type === "permission" &&
            (decision === "acceptForSession" || decision === "acceptAlways")
          ) {
            const state = asker;
            for (const resource of native.save) {
              if (
                !state.grants.some(
                  (grant) => grant.action === native.action && grant.resource === resource,
                )
              ) {
                state.grants.push({ action: native.action, resource, effect: "allow" });
              }
            }
            yield* writeRules(state, rootOf(state).policy).pipe(Effect.ignore({ log: true }));
          }
          const sessionID = Session.ID.make(entry.sessionId);
          if (native.type === "permission" && decision === "decline") {
            yield* client.session
              .synthetic({
                sessionID,
                text: declinedNote(native.action, native.resources),
                delivery: "steer",
                resume: false,
              })
              .pipe(Effect.timeout(REQUEST_REPLY_TIMEOUT), Effect.ignore({ log: true }));
          }
          const delivered = yield* native.type === "permission"
            ? deliver(
                client.permission
                  .reply({
                    sessionID,
                    requestID: Permission.ID.make(native.id),
                    decision: decision !== undefined && approves(decision) ? "once" : "reject",
                    ...(decision === "decline" ? { message: DECLINED } : {}),
                  })
                  .pipe(Effect.catchTags(permissionGone)),
              )
            : deliver(
                (answers === undefined || decision === "decline" || decision === "cancel"
                  ? client.session.form.cancel({
                      sessionID: entry.sessionId,
                      formID: Form.ID.make(native.id),
                    })
                  : client.session.form.reply({
                      sessionID: entry.sessionId,
                      formID: Form.ID.make(native.id),
                      answer: formAnswer(native.form, answers),
                    })
                ).pipe(Effect.catchTags(formGone)),
              );
          yield* forgetRequest(entry);
          if (!delivered) yield* abandonRequest(asker, "answer not delivered");
        },
        (effect, requestInput) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: requestInput.requestId,
                    cause,
                  }),
            ),
          ),
      ),
      readThreadSnapshot: Effect.fn("OpenCode2Adapter.readThreadSnapshot")(
        function* ({ providerThread }) {
          const sessionId = yield* sessionIdOf(providerThread);
          return yield* snapshotOf(providerThread, sessionId);
        },
        (effect, { providerThread }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver,
                    providerThreadId: providerThread.id,
                    cause,
                  }),
            ),
          ),
      ),
      rollbackThread: Effect.fn("OpenCode2Adapter.rollbackThread")(
        function* (rollbackInput) {
          const { providerThread, target } = rollbackInput;
          const sessionId = yield* sessionIdOf(providerThread);
          yield* ensureQuiet(sessionId, "roll back");
          if (!threads.has(sessionId)) {
            yield* runtime.resumeThread({ providerThread });
            yield* ensureQuiet(sessionId, "roll back");
          }
          const boundary = yield* boundaryAfter(
            rollbackInput.providerThreadTurns,
            providerThread.id,
            target.type === "provider_turn" ? target.providerTurn : undefined,
            yield* userMessages(sessionId),
          );
          if (boundary !== null) {
            yield* rollBackTo(sessionId, SessionMessage.ID.make(boundary));
          }
          const keptOrdinal = target.type === "provider_turn" ? target.providerTurn.ordinal : 0;
          const loaded = threads.get(sessionId);
          for (const [id, turn] of loaded?.providerTurns ?? []) {
            if (turn.ordinal > keptOrdinal) loaded?.providerTurns.delete(id);
          }
          const snapshot = yield* snapshotOf(providerThread, sessionId);
          const kept = new Map(
            rollbackInput.providerThreadTurns
              .filter(
                (turn) =>
                  turn.providerThreadId === providerThread.id && turn.ordinal <= keptOrdinal,
              )
              .map((turn) => [turn.id, turn] as const),
          );
          for (const turn of snapshot.providerTurns) kept.set(turn.id, turn);
          return { ...snapshot, providerTurns: [...kept.values()] };
        },
        (effect, rollbackInput) =>
          effect.pipe(
            exclusive(rollbackInput.providerThread),
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver,
                    providerThreadId: rollbackInput.providerThread.id,
                    checkpointId: rollbackInput.target.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
      forkThread: Effect.fn("OpenCode2Adapter.forkThread")(
        function* (forkInput) {
          const source = forkInput.sourceProviderThread;
          const sourceId = yield* sessionIdOf(source);
          // OpenCode forks whatever history the source has, so a fork taken
          // while anything writes to it would copy a run half done.
          yield* ensureQuiet(sourceId, "fork");
          const selected =
            forkInput.providerTurnId === undefined
              ? undefined
              : forkInput.sourceProviderTurns?.find((turn) => turn.id === forkInput.providerTurnId);
          if (forkInput.providerTurnId !== undefined && selected === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode fork boundary turn ${forkInput.providerTurnId} was not found`,
            });
          }
          const before =
            selected === undefined
              ? null
              : yield* boundaryAfter(
                  forkInput.sourceProviderTurns ?? [],
                  source.id,
                  selected,
                  yield* userMessages(sourceId),
                );
          // A fork copies the source's history, model, location and rules; its
          const forked = yield* client.session.fork({
            sessionID: Session.ID.make(sourceId),
            ...(before === null ? {} : { before: SessionMessage.ID.make(before) }),
          });
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            id: idAllocator.derive.providerThread({ driver, nativeThreadId: forked.id }),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: forkInput.targetThreadId,
            ownerNodeId: forkInput.ownerNodeId ?? null,
            nativeThreadRef: ref(forked.id),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: {
              providerThreadId: source.id,
              ...(forkInput.providerTurnId === undefined
                ? {}
                : { providerTurnId: forkInput.providerTurnId }),
            },
            createdAt,
            updatedAt: createdAt,
          };
          // inherits that worktree too, but its first turn starts without a
          // resume, so a target in another worktree takes the session there now.
          const cwd = forkInput.runtimePolicy?.cwd;
          const state = register(providerThread, forked, cwd ?? forked.location.directory);
          yield* writeRules(state, forkInput.runtimePolicy ?? state.policy);
          if (cwd != null && forked.location.directory !== cwd) {
            yield* client.session.move({
              sessionID: Session.ID.make(forked.id),
              directory: AbsolutePath.make(cwd),
            });
          }
          return state.providerThread;
        },
        (effect, forkInput) =>
          effect.pipe(
            exclusive(forkInput.sourceProviderThread),
            Effect.mapError((cause) =>
              isProviderAdapterError(cause)
                ? cause
                : new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause,
                  }),
            ),
          ),
      ),
    };
    return runtime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(OpenCode2ProviderCapabilities),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    // The session borrows the instance's server for as long as it is open, so a
    // spawned server is not idle-stopped under a long tool call.
    openSession: Effect.fn("OpenCode2Adapter.borrowAndOpenSession")(
      function* (input) {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        const connection = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
        return yield* openSession(input, { connection, scope });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});
