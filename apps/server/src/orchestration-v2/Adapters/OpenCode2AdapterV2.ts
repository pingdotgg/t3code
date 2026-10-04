/**
 * The OpenCode 2 runtime behind the `opencode` driver. It talks to the
 * OpenCode server through the HTTP client and reads that
 * server's `/api/event` stream, routed here by session id.
 *
 * A turn is one `session.prompt` (or `session.command`, or `session.compact`
 * for `/compact`); the session's next `session.execution.*` terminal ends it.
 * A steer is another prompt with `delivery: "steer"`, which OpenCode reads at
 * the running execution's next step boundary, so it ends with the turn it
 * joined. Fork and rollback cut the native history before the user message a
 * turn prompted with (its `nativeTurnRef`). Each runtime mode is a set of
 * session permission rules, plan mode is also OpenCode's `plan` agent
 * (switched before the prompt like the model), and OpenCode's permission asks
 * and question forms become runtime requests on the asking session's thread, a
 * subagent's on its parent's.
 *
 * A `subagent` call runs in a child session shown as a subagent thread. A
 * background one outlives its turn; when it ends, OpenCode starts a parent
 * execution T3 did not ask for, which waits here for the continuation turn T3
 * opens for it.
 *
 * @module orchestration-v2/Adapters/OpenCode2AdapterV2
 */
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
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type RunId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { paginate, type OpenCode2StreamEvent } from "../../provider/opencode2/OpenCode2Client.ts";
import * as OpenCode2Server from "../../provider/opencode2/OpenCode2Server.ts";
import {
  parseOpenCodeModelSlug,
  type OpenCodeRuntimeError,
} from "../../provider/opencodeRuntime.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { t3OrchestrationSystemPrompt } from "../../provider/T3OrchestrationInstructions.ts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";

import { providerMessageTextWithAttachmentPaths } from "../AttachmentPrompt.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { backgroundWorkNotification, type BackgroundWorkReport } from "../Notification.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { OPENCODE_PROVIDER, openCodePermissionRequestKind } from "./OpenCodeAdapterV2.ts";
import { openCodeToolTurnItem } from "./OpenCodeToolItems.ts";

const OpenCode2ProviderCapabilities = {
  sessions: {
    // One server serves every location, so one session runtime owns them all.
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // A mode change rewrites the session's rules when its next turn resumes it.
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
    // T3 holds queued messages and starts each as its own turn once the one
    // before it ends, so OpenCode's own `queue` delivery is never used.
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
  // OpenCode enforces each runtime mode through the session's permission rules.
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { readonly type: T }>;
type Tokens = EventOf<"session.step.ended">["data"]["tokens"];

/** What a turn reports against: a run's own turn, or a subagent session's runless one. */
interface TurnOwner {
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly runId: RunId | null;
  readonly runOrdinal: number;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly modelSelection: ModelSelection;
  /** Where the turn runs: a subagent runs in its parent turn's directory. */
  readonly runtimePolicy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "cwd">;
}

interface ActiveTurn {
  readonly input: TurnOwner;
  providerTurn: OrchestrationV2ProviderTurn;
  /** Open text and reasoning blocks, keyed `<assistantMessageID>:<kind>:<ordinal>`. */
  readonly texts: Map<string, OpenBlock>;
  readonly tools: Map<string, { readonly name: string; input: Record<string, unknown> }>;
  readonly startedAt: Map<string, DateTime.Utc>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  /** Input includes cache reads and writes, as 1.x reports it; the parts are also kept apart. */
  readonly usage: {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  steps: number;
  lastStep: Tokens | undefined;
  /**
   * The history item this turn's execution follows, for a turn with no prompt
   * id of T3's: the session's newest item before a `/name` command (null when
   * the history was empty), since `session.command` takes no id and answers
   * without one; the report a continuation turn's execution answers; or, on a
   * subagent's session, the first item queued for its turn. A reconnect
   * backfills that turn from everything after this. Other turns backfill from
   * their own prompt's id (`nativeTurnRef`).
   */
  before: string | null | undefined;
  /** The compaction running in this turn, `/compact` or OpenCode's own when the context fills. */
  compaction: { readonly nativeId: string; readonly startedAt: DateTime.Utc } | undefined;
  compactions: number;
  interrupted: boolean;
  /**
   * Set until the turn's prompt, command or compaction is sent. A Stop before
   * then has nothing on the server to stop, so it ends the turn here and the
   * request is never sent.
   */
  unsent: boolean;
  /**
   * Steers sent into this turn that OpenCode has not delivered yet, by inbox
   * id. Each one wakes the session, so an execution that ends before reading
   * one is followed by another that does, and the turn spans both.
   */
  readonly steers: Set<string>;
  /** This turn's steers OpenCode delivered or cancelled: a retried one is not sent again. */
  readonly settledInbox: Set<string>;
  /** How the last execution ended, while the turn waits for the one that delivers its steers. */
  heldEnd: TurnTerminal | undefined;
  /**
   * Set on a turn started after a timed-out Stop's run left the server: that
   * run's tail can still be on the stream, and everything before this turn's
   * own `session.execution.started` belongs to it.
   */
  awaitingStart: boolean;
  /**
   * Prefixes a subagent session's tool ids in native item ids: the model
   * names tool calls, so a child's could repeat its parent's.
   */
  readonly scope: string;
  /** Set once the turn calls `subagent`: its usage then leaves out the subagents'. */
  usedSubagents: boolean;
}

/** A `subagent` tool call. A background one outlives the turn that made it. */
interface SubagentCall {
  readonly toolId: string;
  readonly nativeId: string;
  /** The calling session and the turn whose item the call is. */
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  prompt: string;
  title: string | null;
  agent: string | undefined;
  model: string | null;
  /** The tool returned while the subagent runs on; the report OpenCode gives its parent settles it. */
  background: boolean;
  child: ThreadState | undefined;
  status: OrchestrationV2Subagent["status"];
  result: string | null;
  completedAt: DateTime.Utc | null;
}

/**
 * An execution OpenCode ran on a thread's session without T3 asking: the
 * parent's answer once a background subagent ended. Its events are held until
 * the continuation turn T3 opens for it takes them.
 */
interface Wake {
  readonly events: Array<OpenCode2StreamEvent>;
  running: boolean;
  /** The background subagents whose end it answers, as its turn's notification names them. */
  readonly reports: Array<BackgroundWorkReport>;
  /** What OpenCode told the model, the continuation's prompt text. */
  readonly detail: string | null;
  /** Stopped, or taken by a user turn: the continuation it asked for is not needed. */
  dropped: boolean;
  /** The last report it delivered (inbox ids are history ids): its execution follows it. */
  readonly after: string | undefined;
  /** The first report it delivered, where fork and rollback cut before its turn. */
  readonly first: string | undefined;
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
  /** What the native session runs now, so a changed selection is switched before prompting. */
  model: ModelRef | undefined;
  /**
   * Set when a turn ended here while OpenCode may still be running it: a Stop
   * that timed out, a prompt whose request failed without a clear answer, or a
   * request T3 could not answer. Execution events carry only the session id,
   * so the next execution end belongs to that run; it clears this and ends no turn.
   */
  unsettled: boolean;
  /** The session's location, where its agents' path rules are read. */
  directory: string;
  /**
   * The agent the session runs (`build`, or `plan` in plan mode); its own path
   * rules stay in force, and a changed mode switches it before prompting.
   */
  agent: string;
  /** The native session's rules as T3 last read or wrote them, and the policy they are for. */
  rules: ReadonlyArray<Rule> | undefined;
  policy: RulesPolicy;
  /** "Allow … this session" answers, kept in the session's rules while T3 has it open. */
  readonly grants: Array<Rule>;
  /** The session's `subagent` calls still running, by tool call id. */
  readonly calls: Map<string, SubagentCall>;
  /**
   * Set on a subagent's session: the call that runs it and the thread it
   * shows in. Each of its executions is a runless turn there.
   */
  subagent:
    | {
        call: SubagentCall;
        readonly appThread: OrchestrationV2AppThread;
        turns: number;
        /** The prompt its next execution answers, shown as that turn's user message. */
        prompt: string | undefined;
        /**
         * The first item queued for the session since its last turn began (its
         * prompt, or a report it answers): where the next turn's history
         * begins, which a reconnect reads back.
         */
        queued: string | undefined;
      }
    | undefined;
  /** Executions OpenCode started on its own, oldest first, each waiting for its turn. */
  readonly wakes: Array<Wake>;
  /**
   * Background subagents whose end OpenCode queued for this session and has
   * not delivered yet, by inbox id. The wake that delivers them names them.
   */
  readonly reports: Map<
    string,
    {
      readonly inboxId: string;
      readonly childId: string;
      readonly report: BackgroundWorkReport;
      readonly text: string;
    }
  >;
  /**
   * Background subagent sessions T3 stopped. OpenCode wakes the parent to
   * report them; a wake that reports only these is stopped as well.
   */
  readonly stoppedChildren: Set<string>;
  /**
   * Steers a turn ended without (a Stop, a failure). They stay in OpenCode's
   * inbox, where the next prompt would deliver them first, so it cancels them.
   */
  readonly strandedSteers: Set<string>;
  /** T3's MCP server as registered for this thread, and the instructions entry sent with it. */
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

/** A permission ask or question form shown to the user and not answered yet. */
interface PendingRequest {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
  readonly node: OrchestrationV2ExecutionNode;
  /** The thread the request is shown on: the asking session's, or its parent's. */
  readonly state: ThreadState;
  readonly turn: ActiveTurn;
  /** The session that asked: the thread's own, or one of its subagents'. */
  readonly sessionId: string;
  /** Set once T3 sends its answer; the orchestrator has already recorded it. */
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
 * A session's permission rules. OpenCode checks the agent's rules and then
 * these, and the last rule that matches decides, so these override the
 * agent's. `paths` are the agent's own allows for its directories (saved tool
 * output, the plan agent's plan directory), which the blanket rules here would
 * otherwise override; `grants` are "Always allow this session" answers.
 */
/**
 * T3's MCP server is registered per directory, not per session, so each thread
 * gets its own `t3-code-<thread>` entry with its own credential. OpenCode names
 * an MCP tool's permission `<server>_<tool>` (non-alphanumerics become `_`).
 */
const t3McpServerName = (threadId: string) =>
  `t3-code-${threadId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`;

/**
 * The rules that keep T3's MCP servers to their own thread, after the mode's:
 * the last matching rule wins, so every thread's T3 server is denied and then
 * this thread's own is allowed again, in every mode. A subagent's session
 * inherits the thread's.
 */
const mcpRules = (threadId: string | null): ReadonlyArray<Rule> =>
  threadId === null
    ? []
    : [
        { action: "t3-code-*", resource: "*", effect: "deny" },
        { action: `${t3McpServerName(threadId)}_*`, resource: "*", effect: "allow" },
      ];

const sessionRules = (
  policy: RulesPolicy,
  paths: ReadonlyArray<Rule>,
  grants: ReadonlyArray<Rule>,
  threadId: string | null,
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
  ...mcpRules(threadId),
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
 * Sent with a declined permission. A reject without a message is OpenCode's
 * "stop": it ends the whole execution, which is Cancel.
 */
const DECLINED = "The user declined this request.";

/**
 * Steered into the session before a decline: a declined shell call reaches the
 * model only as "Unable to execute command", which it retries.
 */
const declinedNote = (action: string, resources: ReadonlyArray<string>) =>
  `The user declined the ${action} request${resources.length === 0 ? "" : ` (${resources.join(", ")})`}. Do not retry it; continue without it or ask the user how to proceed.`;

/** The session-wide choice for a request whose `save` patterns OpenCode would remember. */
const sessionGrantLabel = (action: string, save: ReadonlyArray<string>) =>
  save.every((pattern) => pattern === "*")
    ? `Allow every ${action} request this session`
    : `Allow ${save.join(", ")} this session`;

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

/**
 * A form's fields as T3 questions, or why T3 cannot ask them: a link to open,
 * a field shown only for another answer, a hidden field, or a number or yes/no
 * value. OpenCode's question tool only asks text and multi-select fields.
 */
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

/** T3's answers in OpenCode's shape: a list for a multi-select, text otherwise. */
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

/**
 * An answer to a request OpenCode already dropped (its execution ended, or
 * its session is gone): nothing waits on it, so it counts as delivered.
 */
const permissionGone = {
  PermissionNotFoundError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};
const formGone = {
  FormNotFoundError: () => Effect.void,
  FormAlreadySettledError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};

/** The session rules an agent keeps for its own directories, which T3's blanket rules would override. */
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

/** How a background subagent ended, from the `state` of OpenCode's report to its parent. */
const reportOutcome = (state: string | undefined) =>
  state === "completed"
    ? ("completed" as const)
    : state === "error"
      ? ("failed" as const)
      : state === "cancelled"
        ? ("cancelled" as const)
        : ("unknown" as const);

/** A subagent's answer, without the `<subagent …>` wrapper OpenCode gives the model. */
const subagentOutput = (text: string) =>
  /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(text.trim())?.[1] ?? text;

const isContinuation = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";

/** The native turn id of a continuation turn, which answers a wake and has no prompt. */
const wakeTurnId = (sessionId: string, attemptId: string) => `${sessionId}:wake:${attemptId}`;
const isWakeTurn = (turn: OrchestrationV2ProviderTurn) =>
  turn.nativeTurnRef?.nativeId?.includes(":wake:") === true;

const INTERRUPT_TIMEOUT = "10 seconds";
/** The session instructions entry T3 writes its per-turn system prompt to. */
const INSTRUCTIONS_KEY = "t3-code";
/** A lost event stream is resubscribed this many times, this far apart, before the session breaks. */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = "2 seconds";
const RECONCILE_TIMEOUT = "15 seconds";
/** How long a new turn waits for a reconnect in progress. */
const RECONNECT_WAIT = "30 seconds";
/** A background subagent's result when its end was lost with the event stream. */
const LOST_BACKGROUND =
  "T3 Code lost its connection to OpenCode while this subagent ran, so its result is not shown.";
/** How long a turn waits on the directory's commands or skills before sending the text as is. */
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

/** Whether an answer to a paused request reached the server, trying twice. */
const deliver = <E>(answer: Effect.Effect<void, E>) =>
  answer.pipe(
    Effect.retry({ times: 1 }),
    Effect.timeout(REQUEST_REPLY_TIMEOUT),
    Effect.exit,
    Effect.map(Exit.isSuccess),
  );

type ModelRef = ReturnType<typeof Model.Ref.make>;

/**
 * The user message ids T3 prompts under. OpenCode takes a client id (it must
 * start with `msg_`) and answers a repeat of one in the same session with the
 * item it already has, so a retried request never queues a second message,
 * and a turn knows the message fork and rollback cut at before OpenCode
 * answers. The id is unique across the whole server, which refuses it in any
 * other session (409), so it names the session: another T3 database or
 * environment on the same server repeats thread ids and run ordinals, never
 * session ids. A turn keeps its id in `nativeTurnRef`.
 */
const turnPromptId = (sessionId: string, attemptId: string) =>
  SessionMessage.ID.make(`msg_t3_turn_${sessionId}:${attemptId}`);
const steerPromptId = (sessionId: string, messageId: string) =>
  SessionMessage.ID.make(`msg_t3_steer_${sessionId}:${messageId}`);

/**
 * The user message a turn prompted with. Turns from before T3 chose prompt ids
 * recorded `<session>:attempt:<id>`, which is no message.
 */
const promptOf = (turn: OrchestrationV2ProviderTurn) => {
  const nativeId = turn.nativeTurnRef?.nativeId;
  return nativeId?.startsWith("msg_") === true ? nativeId : undefined;
};

/**
 * Where fork and rollback cut to keep the session's turns up to `kept` (all of
 * them before the first turn when undefined): before the message that starts
 * the next turn that reached OpenCode, which is in `prompts`. That is a turn's
 * prompt, or for a continuation the report it answers. A turn refused before
 * it prompted is not in the session and is passed over, and so is a
 * continuation that took no report. `null` means nothing follows, so there is
 * no cut; a later turn from before T3 chose prompt ids has no known message,
 * so no cut is safe.
 */
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

// Errors already in the adapter channel keep their tag; only lower-level ones are wrapped.
const isProviderAdapterError = Schema.is(ProviderAdapter.ProviderAdapterV2Error);

/**
 * The model OpenCode should run for a `provider/model` slug and its reasoning
 * variant, or undefined for any other slug: sending none would run OpenCode's
 * default while T3 records the requested model.
 */
const modelRef = (selection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"]) => {
  const parsed = parseOpenCodeModelSlug(selection.model);
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

/** OpenCode's own agents for T3's interaction modes; plan mode is its read-only `plan` agent. */
const agentFor = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  input.runtimePolicy.interactionMode === "plan" ? "plan" : "build";

/** `/name args` naming one of the workspace's commands, which OpenCode expands itself. */
const commandOf = (text: string) => {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? undefined : { name: match[1]!, text: match[2] ?? "" };
};

/** Whether a prompt names any skill at all, before the directory's skills are read. */
const SKILL_MENTION = new RegExp(SKILL_MENTION_PATTERN.source, "u");

/** The workspace skills a prompt names with the composer's `$skill` tokens. */
const skillsNamed = (text: string, known: ReadonlySet<string>) => [
  ...new Set(
    [...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) =>
      known.has(match[2] ?? "") ? [match[2]!] : [],
    ),
  ),
];

/**
 * The turn's own tokens: steps add up, and the last step's input is the live
 * context size. A subagent's tokens are its own session's, never these.
 */
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

/**
 * The adapter for one provider instance. It talks to the instance's
 * {@link OpenCode2Server.OpenCode2Server}, which the driver builds from the instance's settings.
 */
export const make = Effect.fn("OpenCode2Adapter.make")(function* (instanceId: ProviderInstanceId) {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const driver = OPENCODE_PROVIDER;

  /**
   * Lends the instance's server to a session until its scope closes. A spawned
   * server that died is started again on the next borrow.
   */
  const borrow = Effect.gen(function* () {
    const lent = yield* Deferred.make<OpenCode2Server.OpenCode2Connection, OpenCodeRuntimeError>();
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
    input: Parameters<ProviderAdapter.ProviderAdapterV2Shape["openSession"]>[0],
    initial: {
      readonly connection: OpenCode2Server.OpenCode2Connection;
      readonly scope: Scope.Closeable;
    },
  ) {
    let connection = initial.connection;
    // Replaced when the session reconnects to a restarted server.
    let client = connection.client;
    const sessionScope = yield* Effect.scope;
    // Context windows by directory, then `provider/model`: a project's own
    // OpenCode config can change a model's limits, and this one runtime serves
    // the instance's threads in every directory.
    const contextWindows = new Map<string, Map<string, number>>();
    /** A thread without a worktree runs where T3 does, as its session is created. */
    const directoryOf = (cwd: string | null | undefined) => cwd ?? serverConfig.cwd;
    const windowOf = (cwd: string | null | undefined, model: string) =>
      contextWindows.get(directoryOf(cwd))?.get(model);
    const now = yield* DateTime.now;
    let session: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: input.runtimePolicy.cwd ?? serverConfig.cwd,
      model: input.modelSelection.model,
      capabilities: OpenCode2ProviderCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
    // Thread sessions, and the sessions of their subagents.
    const threads = new Map<string, ThreadState>();
    // A subagent's session, by its id, to the thread whose session started it.
    const childOwners = new Map<string, ThreadState>();
    // What OpenCode announced about a subagent's session, until its call names it.
    const announced = new Map<string, EventOf<"session.created">["data"]>();
    // Sessions of these threads with an execution running, seen on the stream.
    const busy = new Set<string>();
    const pending = new Map<RuntimeRequestId, PendingRequest>();
    // Events and a wake's replay into its turn are handled one at a time, in order.
    const lock = yield* Semaphore.make(1);
    // Sessions whose `revert.clear` has not had its empty execution yet.
    const clearing = new Map<string, Deferred.Deferred<void>>();
    // Sessions a failed rollback may have left with a staged revert.
    const stagedReverts = new Set<string>();
    // Starting a turn and cutting the history take turns on a session: each
    // checks that the other is not running before its own requests yield.
    const sessionGates = new Map<string, Semaphore.Semaphore>();
    const exclusive =
      (providerThread: OrchestrationV2ProviderThread) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) => {
        const sessionId = providerThread.nativeThreadRef?.nativeId;
        if (sessionId == null) return effect;
        let gate = sessionGates.get(sessionId);
        if (gate === undefined) {
          gate = Semaphore.makeUnsafe(1);
          sessionGates.set(sessionId, gate);
        }
        return gate.withPermit(effect);
      };
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Queue.offer(events, event).pipe(Effect.asVoid);
    const ownerOf = (sessionId: string) => childOwners.get(sessionId) ?? threads.get(sessionId);

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
      directory,
      agent: "build",
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

    /** The thread whose session started this one, through any nesting. */
    const rootOf = (state: ThreadState): ThreadState => {
      let current = state;
      while (current.subagent !== undefined) current = current.subagent.call.state;
      return current;
    };

    /** A thread's session and its subagents' sessions, through any nesting. */
    const sessionsOf = (thread: ThreadState): ReadonlyArray<ThreadState> => [
      thread,
      ...[...threads.values()].filter((state) => {
        for (let above = state.subagent?.call.state; above; above = above.subagent?.call.state) {
          if (above === thread) return true;
        }
        return false;
      }),
    ];

    /**
     * A thread's `subagent` calls still running, its subagents' included: a
     * subagent's background call runs on after the call that made it ended.
     */
    const runningCalls = (thread: ThreadState): ReadonlyArray<SubagentCall> =>
      sessionsOf(thread).flatMap((state) => [...state.calls.values()]);

    /** The `subagent` calls that lead to a session, from its own up to the thread's. */
    const callsAbove = (sessionId: string) => {
      const calls: Array<SubagentCall> = [];
      let current = threads.get(sessionId);
      while (current?.subagent !== undefined) {
        calls.push(current.subagent.call);
        current = current.subagent.call.state;
      }
      return calls;
    };

    /**
     * The turn a request from `sessionId` is shown under. A background
     * subagent's goes to the turn that started it, whose run waits on the
     * subagent; anything else goes to the thread's running turn.
     */
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

    /**
     * What a session still owes its thread once the thread's turn ended:
     * background subagents, held executions, reports OpenCode queued for the
     * follow-up it will start, and anything a subagent's session still runs,
     * such as its own follow-up to such a report.
     */
    const owesWork = (state: ThreadState) =>
      state.wakes.length > 0 ||
      state.reports.size > 0 ||
      (state.subagent !== undefined && busy.has(state.sessionId)) ||
      [...state.calls.values()].some((call) => call.background);

    /** Work that outlives the thread's turn, on its own session or its subagents'. */
    const hasBackground = (thread: ThreadState) => sessionsOf(thread).some(owesWork);

    const setSessionStatus = (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null,
    ) =>
      Effect.gen(function* () {
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

    /** One text or reasoning block, re-emitted with its accumulated text on every change. */
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

    /** The turn's compaction item; its summary is the text OpenCode carries forward. */
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
      interrupted: false,
      unsent: false,
      steers: new Set(),
      settledInbox: new Set(),
      heldEnd: undefined,
      awaitingStart: options.awaitingStart,
      scope: options.scope,
      usedSubagents: false,
    });

    /** A subagent call as its parent turn's item, node and subagent row. */
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

    /**
     * Lists a thread's background subagents on its provider thread, as typed
     * `subagent` work: the thread shows it waits on them after its turn ends,
     * and a Stop reaches them. Emitted only when the list changes.
     */
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

    /**
     * Gives a subagent call its session once both are known: OpenCode names
     * the session on the call's progress, and announces it just before. The
     * session becomes a child thread under the call's item.
     */
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
      // A subagent called again keeps its session's state: how many turns it
      // ran (each one's native id is its own), its grants and rules, and the
      // background work an earlier call left running, which Stop must reach.
      const previous = threads.get(childId);
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
      // OpenCode gives a new session its parent's rules, which are the thread's.
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

    /**
     * Ends a subagent call and every call under it that is still running. A
     * background one outlives the call that made it, as it outlives a turn,
     * unless that call failed.
     */
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
        // A snapshot: settling a call removes it from the map.
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

    /**
     * Opens the runless turn a subagent's session runs each execution in, on
     * its child thread, with the prompt it answers as the turn's user message.
     */
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

    /**
     * Asks the orchestrator for the continuation turn a held wake needs. It
     * names the subagents whose end woke the thread. A wake a Stop or an
     * earlier turn already took needs no turn, so its offer is dropped.
     */
    const offerWake = Effect.fnUntraced(function* (state: ThreadState, wake: Wake) {
      const route = state.providerThread.appThreadId;
      if (route === null) return;
      const notification = backgroundWorkNotification(wake.reports);
      yield* continuationRequests.offer({
        threadId: route,
        providerThreadId: state.providerThread.id,
        driver,
        detail: wake.detail,
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
      // OpenCode drops a request when the asking session's execution ends. A
      // subagent's request shown on this turn ends with it too, unless the
      // subagent runs in the background past a turn that did not fail.
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
      // Blocks still open when the execution ends are final as they stand.
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
      // A foreground subagent ends with the turn that waits on it. A background
      // one outlives a finished or interrupted turn (a user Stop has already
      // stopped it), and a failed turn stops it.
      // A snapshot: settling a call removes it from the map.
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
        providerThreadId: state.providerThread.id,
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
      state.unsettled = true;
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

    /** Stops tracking a request; the session is waiting only while any remain. */
    const forgetRequest = Effect.fnUntraced(function* (entry: PendingRequest) {
      if (!pending.delete(entry.request.id)) return false;
      if (pending.size === 0 && session.status === "waiting") {
        yield* setSessionStatus("running", null);
      }
      return true;
    });

    /**
     * Settles a request OpenCode answered or dropped on its own. T3's own
     * answers are only forgotten: the orchestrator already recorded them.
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

    /**
     * Stops a run no turn of T3's waits on (one a Stop left running, or one
     * found asking after a reconnect): a reject without a message and a
     * cancelled form both end OpenCode's execution. Its end is not a turn's.
     */
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
      // The stopped run's end is not the next turn's.
      state.unsettled = true;
      for (const request of permissions) {
        yield* stopStaleRequest(state.sessionId, { type: "permission", id: request.id });
      }
      for (const form of forms) {
        yield* stopStaleRequest(state.sessionId, { type: "form", id: form.id });
      }
    });

    /**
     * Shows a permission ask or question form on the thread whose session (or
     * subagent session) asked, under that thread's running turn. A request no
     * turn of T3's is waiting on is left for OpenCode's own clients.
     */
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
      // The asking session's own turn knows the tool: a subagent's session runs its own.
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
          // "Always" in OpenCode saves a grant for the whole project, so the
          // session-wide choice is T3's own rule on this session instead.
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
      if (asker.subagent === undefined) asker.unsettled = true;
      yield* finishTurn(asker, {
        status: "failed",
        failure: makeProviderFailure({
          message: `OpenCode asked for ${mapped.unsupported}, which T3 Code can't show. The question was declined.`,
          class: "provider_error",
        }),
      });
    });

    /**
     * A permission ask or question form, from the stream or read back after a
     * reconnect: shown under the turn it blocks, or stopped when it is the run
     * a Stop left behind, which nothing answers.
     */
    const onAsked = Effect.fnUntraced(function* (
      asked:
        | { readonly type: "permission"; readonly request: Permission.Request }
        | { readonly type: "form"; readonly form: NativeForm },
    ) {
      const asking = asked.type === "permission" ? asked.request.sessionID : asked.form.sessionID;
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

    const sessionOfEvent = (event: OpenCode2StreamEvent) =>
      event.type === "unreadable.execution.ended" || event.type === "unreadable.execution.started"
        ? event.sessionID
        : "sessionID" in event.data && typeof event.data.sessionID === "string"
          ? event.data.sessionID
          : undefined;

    const executionEnd = (type: string) =>
      type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted";

    /** A `subagent` call's item, made when the model starts it. */
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
        child: undefined,
        status: "running",
        result: null,
        completedAt: null,
      };
      turn.usedSubagents = true;
      state.calls.set(toolId, call);
      yield* emitSubagent(call);
    });

    /**
     * One event for a session's running turn: its text, tools, steps and end.
     * A `subagent` call is its item and child thread rather than a tool.
     */
    const onTurnEvent = Effect.fnUntraced(function* (
      state: ThreadState,
      turn: ActiveTurn,
      event: OpenCode2StreamEvent,
    ) {
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
          // Its form is the item the user answers; the tool call would repeat it.
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
            // A background call returns at launch; its report settles it.
            if (event.data.metadata?.["status"] === "running") return;
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
          // A refused call (unknown agent, the nesting limit) is a failed subagent.
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
        // `/compact` and OpenCode's own compaction when the context fills
        // (`reason: "auto"`) both run inside a turn's execution.
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
        case "session.execution.started":
          // The execution that delivers steers the last one ended without.
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
              class: "provider_error",
            }),
          });
        default:
          return;
      }
    });

    /**
     * An execution OpenCode started on a thread's session with no turn of T3's
     * running: the parent's answer to a background subagent's report. It is
     * held for the continuation turn it asks for, or stopped when it only
     * reports subagents a Stop ended.
     */
    /**
     * Takes the reports an execution OpenCode started on its own delivers. When
     * they all report subagents a Stop ended, that execution only answers the
     * Stop, so it is stopped and `stopped` is true.
     */
    const takeReports = Effect.fnUntraced(function* (state: ThreadState) {
      const delivered = [...state.reports.values()];
      state.reports.clear();
      const stopped =
        delivered.length > 0 &&
        delivered.every((entry) => state.stoppedChildren.has(entry.childId));
      for (const entry of delivered) state.stoppedChildren.delete(entry.childId);
      if (stopped) {
        state.unsettled = true;
        yield* client.session
          .interrupt({ sessionID: Session.ID.make(state.sessionId) })
          .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
      }
      return { delivered, stopped };
    });

    const onWake = Effect.fnUntraced(function* (state: ThreadState) {
      const { delivered, stopped } = yield* takeReports(state);
      if (stopped) return;
      const wake: Wake = {
        events: [],
        running: true,
        reports: delivered.map((entry) => entry.report),
        detail: delivered.length === 0 ? null : delivered.map((entry) => entry.text).join("\n\n"),
        dropped: false,
        after: delivered.at(-1)?.inboxId,
        first: delivered[0]?.inboxId,
      };
      state.wakes.push(wake);
      yield* Effect.logInfo("OpenCode started a turn on its own; asking for a continuation.", {
        providerThreadId: state.providerThread.id,
      });
      yield* offerWake(state, wake);
    });

    /** A background subagent's end, as OpenCode queues it for its parent. */
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
      const call = [...state.calls.values()].find(
        (candidate) => candidate.child?.sessionId === childId,
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
      if (call === undefined) return;
      yield* settleCall(
        call,
        state.stoppedChildren.has(childId)
          ? "interrupted"
          : outcome === "failed"
            ? "failed"
            : outcome === "cancelled"
              ? "cancelled"
              : "completed",
        subagentOutput(payload.text),
      );
    });

    /**
     * The thread whose held execution an event belongs to: the thread's own
     * session, or a subagent session its held execution started.
     */
    const holderOf = (sessionId: string) => {
      const own = threads.get(sessionId);
      if (own !== undefined) return own.wakes.at(-1)?.running === true ? own : undefined;
      // A subagent a held execution started is named only when that execution replays.
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

    /** Ends a turn held for its steers once none is left to deliver. */
    const endIfSettled = (state: ThreadState, turn: ActiveTurn) =>
      turn.heldEnd !== undefined && turn.steers.size === 0
        ? finishTurn(state, turn.heldEnd)
        : Effect.void;

    const handleEvent = Effect.fnUntraced(function* (event: OpenCode2StreamEvent) {
      const sessionId = sessionOfEvent(event);
      // `revert.clear` wakes the session into an empty execution of its own
      // (2.0.18's `Session.revert.clear` ends with a wake). It is no run of
      // T3's, and no follow-up to a subagent either.
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
          busy.add(sessionId);
        } else if (event.type === "unreadable.execution.ended" || executionEnd(event.type)) {
          busy.delete(sessionId);
        }
      }
      // A subagent's session: named on its parent's `subagent` call just after.
      if (event.type === "session.created" && event.data.parentID !== undefined) {
        const owner = ownerOf(event.data.parentID);
        if (owner !== undefined) {
          childOwners.set(event.data.sessionID, owner);
          announced.set(event.data.sessionID, event.data);
        }
        return;
      }
      // What a held execution does, and what the subagents it starts do,
      // waits for the turn that takes it.
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

    /** Handles one event for its session, as the turn running there sees it. */
    const route = Effect.fnUntraced(function* (
      event: OpenCode2StreamEvent,
      sessionId: string | undefined,
    ) {
      // The end of the run a timed-out Stop left behind; no turn is its own.
      const ended =
        event.type === "unreadable.execution.ended" || executionEnd(event.type)
          ? threads.get(sessionId ?? "")
          : undefined;
      if (ended?.unsettled === true) {
        ended.unsettled = false;
        return;
      }
      // Marks where a running turn's own execution begins; it never ends one.
      // With no turn running it is a subagent's or a follow-up's start, below.
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
      // Answered in another OpenCode client, or dropped by OpenCode: a reject
      // it sends on its own (a Stop, or another reject in the same session)
      // cancels the request. T3's own answers are settled where they are sent.
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
      // Cancelled, or delivered into a turn already running: no wake reports it.
      // A steer of the running turn's is settled the same way.
      if (event.type === "session.inbox.cancelled" || event.type === "session.inbox.delivered") {
        state.reports.delete(event.data.inboxID);
        const turn = state.active;
        if (turn !== undefined && turn.steers.delete(event.data.inboxID)) {
          turn.settledInbox.add(event.data.inboxID);
          // A cancelled steer may leave a held turn nothing to wait for.
          if (event.type === "session.inbox.cancelled") yield* endIfSettled(state, turn);
        }
        return;
      }
      // A subagent's later prompts (a resumed subagent) open its next turn's message.
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
      // Each execution of a subagent's session is a turn on its child thread,
      // unless it only answers the reports of nested subagents a Stop ended.
      if (state.subagent !== undefined && state.active === undefined && started) {
        if ((yield* takeReports(state)).stopped) {
          state.subagent.queued = undefined;
          return;
        }
        return yield* startChildTurn(state);
      }
      const turn = state.active;
      if (turn === undefined) {
        // OpenCode started the thread's session on its own.
        if (started && state.subagent === undefined) return yield* onWake(state);
        return;
      }
      // A session runs one execution at a time, and each opens with `started`
      // on this ordered stream, so what comes before it is the stopped run's.
      if (turn.awaitingStart) {
        if (event.type === "session.execution.started") turn.awaitingStart = false;
        return;
      }
      return yield* onTurnEvent(state, turn, event);
    });

    // The stream is the only terminal signal, and it is volatile: events sent
    // while it is down are gone, and a restarted server never ends the
    // execution it lost. So a lost stream reconnects, then reconciles each
    // running turn from the server's own state (see `reconcile`). Only when
    // reconnecting keeps failing are the turns failed and the session broken,
    // so T3 reopens it. Set first, so a turn starting meanwhile waits or refuses.
    let streamFailure: string | undefined;
    let reconnected = yield* Deferred.make<void>();
    const failAll = Effect.fnUntraced(function* (message: string) {
      streamFailure = message;
      yield* Deferred.succeed(reconnected, undefined);
      for (const state of threads.values()) {
        const failure = makeProviderFailure({ message, class: "transport_error" });
        yield* finishTurn(state, { status: "failed", failure }, "broken");
      }
      // Nothing can report a background subagent's end any more.
      for (const state of threads.values()) {
        for (const call of runningCalls(state)) yield* settleCall(call, "failed");
        for (const wake of state.wakes.splice(0)) wake.dropped = true;
        state.reports.clear();
      }
      yield* setSessionStatus("error", message);
      yield* Queue.end(events);
    });
    /**
     * Emits what a running turn missed while the stream was down, from the
     * session's history since the turn began: text, reasoning and tools, each
     * under the same native id its live events would have used, so nothing
     * already shown is duplicated. A turn begins at its prompt, whose id T3
     * chose (`nativeTurnRef`), or after `before` for a `/name` command or a
     * continuation.
     * Returns how that history says the turn's execution ended: the `idle` item
     * OpenCode appends after each one, or undefined when there is none after
     * the turn's start.
     */
    const backfill = Effect.fnUntraced(function* (sessionId: string, state: ThreadState) {
      const turn = state.active;
      if (turn === undefined) return undefined;
      const promptId = promptOf(turn.providerTurn);
      const { before } = turn;
      if (promptId === undefined && before === undefined) return undefined;
      const start = before !== undefined ? before : promptId;
      const read = yield* paginate(
        { sessionID: Session.ID.make(sessionId), order: "desc" as const, limit: 50 },
        client.message.list,
      ).pipe(
        Stream.takeUntil((message) => message.id === start),
        Stream.runCollect,
      );
      // Without its start the history holds only earlier turns (the stream
      // dropped before the prompt landed): none of it is this turn's. A null
      // `before` is a command that started on an empty history.
      const found = start === null || read.at(-1)?.id === start;
      if (!found) return undefined;
      const recent = before !== undefined && before !== null ? read.slice(0, -1) : read;
      const idle = recent.find((message) => message.type === "idle");
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
     * Settles each thread turn that was running when the stream dropped, from
     * the server: a session still running keeps its turn (its next events
     * arrive on the new stream); one that stopped ends the turn with the
     * outcome of the `idle` item after the turn's start. A restarted server
     * writes no such item for the execution it lost, and `session.outcome` is
     * still the previous execution's, so no `idle` means the turn was
     * interrupted. A continuation turn is settled the same way, from the report
     * its execution answers. A turn still holding for an undelivered steer only
     * ends once the session is idle. Permission asks and question forms are
     * read back from every session still running, so a run that asked during
     * the gap can be answered.
     *
     * What the stream carried outside a turn is not read back: a background
     * subagent's report, a follow-up OpenCode started on its own, or one held
     * for its continuation turn. So background work is settled, not resumed: a
     * subagent whose session stopped ends as interrupted, and a thread's held
     * follow-ups and queued reports are dropped, so nothing waits on an event
     * that already went by.
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
      if (running.length === 0 && background.length === 0 && busy.size === 0) return;
      const active = yield* client.session.active();
      // An execution that ended while the stream was down never said so.
      for (const sessionId of busy) if (!(sessionId in active)) busy.delete(sessionId);
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
        // A subagent still running keeps its call; its end arrives on the new stream.
        for (const call of runningCalls(state)) {
          const child = call.child?.sessionId;
          if (child === undefined || !(child in active)) {
            yield* settleCall(call, "interrupted", LOST_BACKGROUND);
          }
        }
        // A subagent's session holds reports of its own background subagents.
        for (const session of sessionsOf(state)) {
          for (const wake of session.wakes.splice(0)) wake.dropped = true;
          session.reports.clear();
        }
      }
      // A request asked while the stream was down was never shown, and the
      // run waits on it; one T3 shows that OpenCode no longer lists was
      // answered elsewhere or dropped with its execution. A session that
      // stopped dropped its requests.
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
      // A snapshot: settling a request removes it from the map.
      for (const entry of Array.from(pending.values())) {
        if (listed.get(entry.sessionId)?.has(entry.native.id) !== true) {
          yield* settleRequest(entry, "cancelled");
        }
      }
    });

    /**
     * Subscribes again, on a restarted server if the old one is gone, and
     * reconciles. Retried a few times; the caller fails everything after that.
     */
    const reconnect = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const next = yield* borrow.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
      );
      const stream = yield* next.events.pipe(Effect.tapError(() => Scope.close(scope, Exit.void)));
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
    // Release the event-stream connection when the session closes.
    yield* Effect.addFinalizer(() => Scope.close(currentScope, Exit.void));
    const follow = (stream: Stream.Stream<OpenCode2StreamEvent, unknown>): Effect.Effect<void> =>
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

    // Both local managed and external servers outlive T3. Stop only this
    // runtime's active turns before releasing its connection.
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

    // Context windows come from the server's model list for a directory, read
    // when the session opens, before a thread first runs in another directory,
    // and again after a turn whose model had none yet. A directory counts as
    // known once its read starts, so a failed read is retried only after a turn.
    const readModels = (directory: string) =>
      Effect.suspend(() => {
        const windows = contextWindows.get(directory) ?? new Map<string, number>();
        contextWindows.set(directory, windows);
        return client.model.list({ location: { directory } }).pipe(
          Effect.timeout("5 seconds"),
          Effect.tap((models) =>
            Effect.sync(() => {
              for (const model of models.data) {
                // A model's input limit, when it has one, is its real headroom.
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

    // Each agent's own path allows, by the directory they were listed for.
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
          // The failure can carry the server's URL or response text, so only its
          // tag is annotated; the full failure stays in the log's cause.
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

    /**
     * The rules a thread's session runs `policy` with. Full access allows
     * every path already, so the agent's own path rules are read only for the
     * modes that narrow it.
     */
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
        appThreadId,
      );
    });

    /** Writes the session's rules for `policy` when they differ from what it has. */
    const writeRules = Effect.fnUntraced(function* (state: ThreadState, policy: RulesPolicy) {
      // A subagent's session may use its thread's T3 server, the root's.
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

    const register = (
      providerThread: OrchestrationV2ProviderThread,
      native: {
        readonly id: string;
        readonly model?: ModelRef | undefined;
        readonly agent?: string | undefined;
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
        existing.rules = native.permissions;
        return existing;
      }
      const state = newThreadState(native.id, providerThread, directory, undefined);
      state.model = native.model;
      state.agent = native.agent ?? state.agent;
      state.rules = native.permissions;
      threads.set(native.id, state);
      return state;
    };

    /**
     * Refuses to cut or copy a session's history while something writes to
     * it: a turn of T3's, an execution seen running on the stream (a held
     * follow-up), or a run on the server this runtime does not own: one a
     * timed-out Stop or an unanswered request left behind, or any run on a
     * session loaded after the server outlived T3. Only that last case asks
     * the server. A rollback also waits for background subagents, whose
     * reports wake the session into the history it would cut.
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

    /**
     * Takes back steers a finished turn left in OpenCode's inbox. One whose
     * cancel fails may still be there, so it is tried again before the next prompt.
     */
    const cancelStrandedSteers = Effect.fnUntraced(function* (state: ThreadState) {
      const sessionID = Session.ID.make(state.sessionId);
      // A snapshot: a cancelled steer leaves the set.
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
     * Truncates the session's history before `boundary`: OpenCode stages the
     * revert, then commits it. If either fails or is interrupted the stage is
     * cleared, since OpenCode commits a staged revert on the next prompt; a
     * clear that fails too is tried again before that prompt. Files stay where
     * they are: T3 restores its own checkpoint when the user asked for files,
     * and a rewind without files must not touch them.
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
     * The ids fork and rollback can cut before: the session's prompts, and the
     * reports continuations answer. The list takes one type, so it reads all.
     */
    const userMessages = (sessionId: string) =>
      paginate({ sessionID: Session.ID.make(sessionId), limit: 100 }, client.message.list).pipe(
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

    /** The session's history as V2 messages, read after any change T3 made to it. */
    const snapshotOf = Effect.fnUntraced(function* (
      providerThread: OrchestrationV2ProviderThread,
      sessionId: string,
    ) {
      const history = yield* paginate(
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

    const promptText = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      providerMessageTextWithAttachmentPaths({
        text: turnInput.message.text,
        attachments: turnInput.message.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
      }).trim();

    const removeMcp = (mcp: { readonly name: string; readonly directory: string }) =>
      Effect.suspend(() =>
        client.mcp.remove({ server: mcp.name, location: { directory: mcp.directory } }),
      ).pipe(Effect.timeout("5 seconds"), Effect.ignore({ log: true }));

    // Both managed and external servers outlive this runtime's registrations.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...threads.values()].flatMap((state) => (state.mcp === undefined ? [] : [state.mcp])),
        removeMcp,
        { concurrency: 8, discard: true },
      ),
    );

    /**
     * T3's MCP server for this thread, and the per-turn instructions. The MCP
     * server is registered for the session's directory under the thread's own
     * name and credential (the session rules allow only it), and removed when
     * the thread unloads or the session closes. OpenCode 2 has no per-prompt
     * system field, so the instructions are a session instructions entry,
     * which applies from the next step; it is only rewritten when it changes.
     */
    const prepareTurn = Effect.fnUntraced(function* (
      sessionId: string,
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      const mcpSession = McpProviderSession.readMcpProviderSession(turnInput.threadId);
      const directory = turnInput.runtimePolicy.cwd ?? serverConfig.cwd;
      const name = t3McpServerName(turnInput.threadId);
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
      // T3's tools are an addition: a server that cannot add them still runs the turn.
      if (wanted !== undefined && state.mcp === undefined) {
        const added = yield* client.mcp
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
        if (added) state.mcp = wanted;
      }
      const instructions = [
        buildRuntimeInstructions({ harness: "OpenCode", model: turnInput.modelSelection.model }),
        t3OrchestrationSystemPrompt(state.mcp !== undefined),
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

    /** Installs a turn T3 started; every path after it ends the turn with a terminal. */
    const beginTurn = (
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      awaitingStart: boolean,
    ) =>
      Effect.gen(function* () {
        const startedAt = yield* DateTime.now;
        const nativeTurnId = `${state.sessionId}:attempt:${turnInput.attemptId}`;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({ driver, nativeTurnId }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          // The user message it prompts with, where fork and rollback cut. A
          // continuation prompts nothing; it records the report it answers
          // once it takes its execution.
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
        // No stream is left to end this turn, so it must not start.
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

    /** Feeds a held execution's events to the turn now running on its session. */
    const replay = Effect.fnUntraced(function* (wake: Wake) {
      wake.dropped = true;
      for (const event of wake.events) yield* route(event, sessionOfEvent(event));
    });

    /**
     * A user turn that starts while OpenCode runs an execution on its own: the
     * prompt joins that execution, so the turn takes it, and its continuation
     * turn is no longer needed. Executions that already ended stay for theirs.
     */
    const takeRunningWake = Effect.fnUntraced(function* (state: ThreadState) {
      const wake = state.wakes.at(-1);
      if (wake?.running !== true) return;
      state.wakes.pop();
      yield* replay(wake);
    });

    /**
     * The continuation turn for an execution OpenCode started on its own: it
     * takes the oldest one held and ends with it. One already taken (a user
     * turn joined it) leaves nothing to run, so the turn ends at once.
     */
    const runWake = Effect.fnUntraced(function* (
      state: ThreadState,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      yield* beginTurn(state, turnInput, false);
      yield* lock.withPermit(
        Effect.gen(function* () {
          const wake = state.wakes.shift();
          if (wake === undefined) return yield* finishTurn(state, { status: "completed" });
          const turn = state.active;
          if (turn !== undefined && wake.after !== undefined) turn.before = wake.after;
          // Its first report is where its history begins, so fork and rollback cut there.
          if (turn !== undefined && wake.first !== undefined) {
            turn.providerTurn = { ...turn.providerTurn, nativeTurnRef: ref(wake.first, "weak") };
          }
          yield* replay(wake);
        }),
      );
    });

    /**
     * Stops a thread's background subagents and any execution OpenCode is
     * running on its own. Their sessions end as interrupted; the reports
     * OpenCode then queues wake the parent into an execution that is stopped
     * as well, so no turn takes it. A subagent the Stop did not reach runs on,
     * so its call stays tracked: the session is not released under it, and
     * the next Stop tries it again.
     */
    const stopBackground = Effect.fnUntraced(function* (state: ThreadState) {
      const calls = runningCalls(state).filter((call) => call.background);
      // Every session under the thread, which a stopped subagent may report to.
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
      // Each child reports to the session that called it, so its marker goes
      // on that caller's state: the thread's own, or a subagent's for a nested one.
      const children = new Map(
        calls.flatMap((call) => childrenOf(call).map((childId) => [childId, call.state] as const)),
      );
      const unreached = new Set<string>();
      for (const [childId, caller] of children) {
        caller.stoppedChildren.add(childId);
        const reached = yield* client.session
          .interrupt({ sessionID: Session.ID.make(childId) })
          .pipe(
            // A session that is gone runs nothing.
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
      // Its end closes its turn; one the Stop did not reach stays pending work.
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
          // A report already queued starts a follow-up the Stop must end too.
          for (const caller of callers) {
            for (const report of caller.reports.values()) {
              caller.stoppedChildren.add(report.childId);
            }
          }
          // A held wake no turn will take: its execution is stopped, not replayed.
          const running = state.wakes.some((wake) => wake.running);
          for (const wake of state.wakes.splice(0)) wake.dropped = true;
          if (running) {
            state.unsettled = true;
            yield* client.session
              .interrupt({ sessionID: Session.ID.make(state.sessionId) })
              .pipe(Effect.timeout(INTERRUPT_TIMEOUT), Effect.ignore({ log: true }));
          }
        }),
      );
    });

    /**
     * What a turn sends: `/compact` compacts, `/name args` naming a workspace
     * command runs it, and anything else is a prompt with the `$skill`s it
     * names attached. Commands and skills are read from the session's
     * directory only when the text could use them. A turn stopped meanwhile
     * sends nothing.
     */
    const submit = Effect.fnUntraced(function* (
      sessionId: string,
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      state: ThreadState,
      turn: ActiveTurn,
    ) {
      const sessionID = Session.ID.make(sessionId);
      /** Whether the turn still sends; past this point a Stop goes to the server. */
      const sending = () => {
        if (state.active !== turn || turn.interrupted) return false;
        turn.unsent = false;
        return true;
      };
      const text = turnInput.message.text.trim();
      const bare = turnInput.message.attachments.length === 0;
      // The turn's own id, so fork and rollback cut before this turn's item.
      const id = turnPromptId(sessionId, turnInput.attemptId);
      if (bare && text === "/compact") {
        if (!sending()) return;
        return yield* client.session.compact({ sessionID, id }).pipe(Effect.asVoid);
      }
      const location = { directory: turnInput.runtimePolicy.cwd ?? serverConfig.cwd };
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
      if (!sending()) return;
      return yield* client.session
        .prompt({
          sessionID,
          id,
          text: promptText(turnInput),
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
      // A caller that names no directory gets the one this session opened in.
      getModelContextWindow: (selection, cwd) =>
        selection.instanceId === instanceId
          ? windowOf(cwd === undefined ? session.cwd : cwd, selection.model)
          : undefined,
      ensureThread: (threadInput) =>
        Effect.gen(function* () {
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
          const directory = threadInput.runtimePolicy.cwd ?? serverConfig.cwd;
          const policy = threadInput.runtimePolicy;
          // A new session runs OpenCode's default agent.
          const permissions = yield* rulesFor(
            { directory, agent: "build", grants: [] },
            policy,
            threadInput.threadId,
          );
          const created = yield* client.session.create({
            location: Location.PublicRef.make({ directory: AbsolutePath.make(directory) }),
            model,
            permissions,
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
            { id: created.id, model: created.model, agent: created.agent, permissions },
            directory,
          );
          state.policy = policy;
          return state.providerThread;
        }).pipe(
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
      resumeThread: (threadInput) =>
        Effect.gen(function* () {
          const sessionId = yield* sessionIdOf(threadInput.providerThread);
          if (threadInput.runtimePolicy !== undefined) {
            yield* readModelsOnce(threadInput.runtimePolicy.cwd);
          }
          // 1.x session ids survive the upgrade; a server without this session
          // fails the resume, so T3 recreates the thread with a handoff.
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
          // OpenCode keeps no request across its own restart, but a server that
          // outlived T3 may still wait on one T3 no longer shows.
          if (!loaded) yield* stopLeftoverRequests(state);
          // The session gets the rules for this thread's mode: it may have run
          // another mode, or been made by 1.x or an earlier build.
          yield* writeRules(state, threadInput.runtimePolicy ?? state.policy);
          // A thread moved to another worktree takes its session with it.
          if (cwd != null && native.location.directory !== cwd) {
            yield* client.session.move({
              sessionID: Session.ID.make(sessionId),
              directory: AbsolutePath.make(cwd),
            });
          }
          return state.providerThread;
        }).pipe(
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
      // `/compact` is its own turn, which `startTurn` sends as `session.compact`.
      compactThread: (turnInput) =>
        runtime.startTurn({ ...turnInput, message: { ...turnInput.message, text: "/compact" } }),
      startTurn: (turnInput) =>
        Effect.gen(function* () {
          // A lost stream is reconnecting: wait for it rather than prompt into
          // a dead stream, and refuse the turn before any request if it gave up.
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
                });
              }
              // OpenCode already ran this turn on its own; it prompts nothing.
              if (isContinuation(turnInput)) return yield* runWake(state, turnInput);
              // After a timed-out Stop the server says whether that run is gone. A
              // run still going is stopped again and this turn fails so it can be
              // sent again; a run that is gone may still have its end on the
              // stream, which the turn skips.
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
              // Installs the turn; every path after it ends the turn with a terminal.
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
              // A turn T3 will not run still starts and fails, so the refusal is what
              // the user reads.
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
              // written so they keep that agent's own path allows. Switching to or
              // from `plan` queues OpenCode's own "Plan mode" reminder for the prompt.
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
              for (const call of runningCalls(state)) {
                if (call.child === undefined) continue;
                yield* writeRules(call.child, turnInput.runtimePolicy).pipe(
                  Effect.timeout(REQUEST_REPLY_TIMEOUT),
                  Effect.ignore({ log: true }),
                );
              }
              // A selection changed since the last turn applies now; OpenCode keeps
              // the session's model otherwise.
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
              // An execution OpenCode is running on its own takes this prompt at
              // its next step, so this turn is that execution from here on.
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
                    // Without a clear rejection the server may have taken the
                    // prompt, so the next turn checks before it prompts again.
                    if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) state.unsettled = true;
                    yield* finishTurn(state, {
                      status: "failed",
                      failure: makeProviderFailure({ cause, class: "provider_error" }),
                    });
                  })
                : Effect.void,
            ),
          );
        }).pipe(
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
      steerTurn: (steerInput) =>
        Effect.gen(function* () {
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
          // A retried steer that already reached the model is not sent again.
          if (turn.settledInbox.has(inboxID)) return;
          turn.steers.add(inboxID);
          state.strandedSteers.delete(inboxID);
          yield* client.session
            .prompt({
              sessionID: Session.ID.make(sessionId),
              id: inboxID,
              text: providerMessageTextWithAttachmentPaths({
                text: steerInput.message.text,
                attachments: steerInput.message.attachments,
                attachmentsDir: serverConfig.attachmentsDir,
              }).trim(),
              delivery: "steer",
            })
            .pipe(
              Effect.tapError((cause) =>
                lock.withPermit(
                  Effect.gen(function* () {
                    turn.steers.delete(inboxID);
                    // Without a clear refusal OpenCode may hold it; the next prompt takes it back.
                    if (!CLEAR_PROMPT_REJECTIONS.has(cause._tag)) state.strandedSteers.add(inboxID);
                    if (state.active === turn) yield* endIfSettled(state, turn);
                  }),
                ),
              ),
            );
        }).pipe(
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
      interruptTurn: (interruptInput) =>
        Effect.gen(function* () {
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
          // The session answers with `session.execution.interrupted`, which ends
          // the turn. A server that does not answer in time is stuck, so the turn
          // ends here instead of waiting on it.
          turn.interrupted = true;
          const reply = yield* client.session
            .interrupt({ sessionID: Session.ID.make(sessionId) })
            .pipe(
              Effect.timeoutOption(INTERRUPT_TIMEOUT),
              // A Stop that never reached the server stopped nothing.
              Effect.tapError(() =>
                Effect.sync(() => {
                  turn.interrupted = false;
                }),
              ),
            );
          if (reply._tag === "None") {
            state.unsettled = true;
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          // Between the executions a late steer spans nothing runs yet. The
          // steers are taken back, and a run they already started is skipped.
          if (!reply.value.interrupted && state.active === turn && turn.heldEnd !== undefined) {
            state.unsettled = true;
            yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
            return yield* cancelStrandedSteers(state);
          }
          // Nothing was running because the turn has not sent its request yet
          // (it is reading the workspace's commands or skills): it ends here,
          // and never sends it.
          if (!reply.value.interrupted && state.active === turn && turn.unsent) {
            return yield* lock.withPermit(finishTurn(state, { status: "interrupted" }));
          }
          // Nothing was running. Unless the execution already ended (its event
          // is on the way), the turn is still open and nothing stopped.
          if (!reply.value.interrupted && state.active === turn) {
            turn.interrupted = false;
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: OPENCODE_PROVIDER,
              detail: `OpenCode session ${sessionId} had nothing running to stop`,
            });
          }
        }).pipe(
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
      unloadThread: ({ providerThread }) =>
        Effect.gen(function* () {
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
      respondToRuntimeRequest: (requestInput) =>
        Effect.gen(function* () {
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
          // session-wide answer is a rule on this session instead. The grant
          // is best effort: this request is answered either way.
          // The session that asked waits on the answer and holds the grant: a
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
            // A subagent runs under its thread's mode.
            yield* writeRules(state, rootOf(state).policy).pipe(Effect.ignore({ log: true }));
          }
          const sessionID = Session.ID.make(entry.sessionId);
          // Best effort: the decline stands without the note.
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
                    // Without a message OpenCode ends the whole run, which is Cancel.
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
        }).pipe(
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
      readThreadSnapshot: ({ providerThread }) =>
        Effect.gen(function* () {
          const sessionId = yield* sessionIdOf(providerThread);
          return yield* snapshotOf(providerThread, sessionId);
        }).pipe(
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
      rollbackThread: (rollbackInput) =>
        Effect.gen(function* () {
          const { providerThread, target } = rollbackInput;
          const sessionId = yield* sessionIdOf(providerThread);
          // A stopped run's end may still be on the stream, so `unsettled`
          // stays for the next turn to skip it.
          yield* ensureQuiet(sessionId, "roll back");
          // A session this runtime has not loaded yet is loaded the way a turn
          // would load it, which stops anything it still waits on. Requests it
          // stops end their run, so the server is asked again after that.
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
          // The turns after the target left the history with their messages.
          // The snapshot lists the ones kept as T3 recorded them, which a
          // runtime that loaded the session after they ran never saw.
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
          // The snapshot's head is the last user message OpenCode kept.
          return { ...snapshot, providerTurns: [...kept.values()] };
        }).pipe(
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
      forkThread: (forkInput) =>
        Effect.gen(function* () {
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
          // message ids are new, so it has no turns T3 could cut at yet.
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
          // A fork keeps the source's location. The target thread usually
          // inherits that worktree too, but its first turn starts without a
          // resume, so a target in another worktree takes the session there now.
          const cwd = forkInput.runtimePolicy?.cwd;
          const state = register(providerThread, forked, cwd ?? forked.location.directory);
          // The fork runs the target thread's mode, not whatever the source ran.
          yield* writeRules(state, forkInput.runtimePolicy ?? state.policy);
          if (cwd != null && forked.location.directory !== cwd) {
            yield* client.session.move({
              sessionID: Session.ID.make(forked.id),
              directory: AbsolutePath.make(cwd),
            });
          }
          return state.providerThread;
        }).pipe(
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
    openSession: (input) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        const connection = yield* borrow.pipe(Effect.provideService(Scope.Scope, scope));
        return yield* openSession(input, { connection, scope });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
});
