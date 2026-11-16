import {
  CommandId,
  FYI_RETURNING_RUN_STATUSES,
  FYI_TEXT_MAX_CHARS,
  fyiDeliveryState,
  fyiElement,
  fyiSentAt,
  MessageId,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

export type FyiItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> & {
  readonly fyi: true;
};

export const isFyiItem = (item: OrchestrationV2TurnItem): item is FyiItem =>
  item.type === "user_message" && item.fyi === true;

/** The thread's FYI items that wait for a turn, from a projection that holds every run and item. */
const waitingFyiItems = (projection: {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
}): ReadonlyArray<FyiItem> =>
  projection.turnItems.filter(
    (item): item is FyiItem =>
      isFyiItem(item) &&
      fyiDeliveryState(
        item,
        projection.runs.find((run) => run.id === item.runId),
      ) === "waiting",
  );

const returningStatuses = FYI_RETURNING_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * SQL mirror of `fyiDeliveryState(...) === "waiting"` (contracts `fork/fyi.ts`), for a turn item
 * row `item` left-joined to its run row `run`. `Fyi.test.ts` checks the two agree.
 */
export const FYI_WAITING_SQL = `item.type = 'user_message'
  AND json_extract(item.payload_json, '$.fyi') = 1
  AND NOT (
    run.run_id IS NOT NULL
    AND item.node_id IS NOT NULL
    AND item.node_id IS json_extract(run.payload_json, '$.rootNodeId')
    AND run.status NOT IN (${returningStatuses})
  )`;

const LEADING_SKILL_MENTION = new RegExp(`^\\s*${SKILL_MENTION_PATTERN.source}`, "u");

/**
 * Goal and slash commands and a leading skill mention go to the provider as typed (Grok runs only
 * a skill named first). A native restart continuation sends no text, and Claude, Muse, Pi, ACP and
 * OpenCode drain a provider continuation without sending its text.
 */
export function turnCarriesFyi(input: {
  readonly message: Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource"> & {
    readonly text: string;
    readonly attachments: ReadonlyArray<unknown>;
  };
  readonly goalCommand: boolean;
  readonly resumesNatively: boolean;
}): boolean {
  const { message } = input;
  return (
    !input.goalCommand &&
    !input.resumesNatively &&
    !(message.createdBy === "agent" && message.creationSource === "provider") &&
    !(message.attachments.length === 0 && message.text.trimStart().startsWith("/")) &&
    !LEADING_SKILL_MENTION.test(message.text)
  );
}

export const FYI_TURN_BUDGET_CHARS = FYI_TEXT_MAX_CHARS;
export const FYI_TOOL_BATCH_BUDGET_CHARS = 8_000;

export interface RenderedFyi {
  /** Empty when nothing waits. */
  readonly text: string;
  /** Exactly the entries in `text`, so only these are recorded as delivered. */
  readonly rendered: ReadonlyArray<FyiItem>;
}

const SEPARATOR = "\n\n";

/**
 * Oldest first, each whole entry that keeps the header and entries within the budget; an entry
 * that does not fit waits. With `atLeastOne`, the oldest goes even past the budget.
 */
const fit = (
  waiting: ReadonlyArray<FyiItem>,
  header: string,
  budget: number,
  atLeastOne: boolean,
) => {
  const ordered = waiting.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(fyiSentAt(left)) - DateTime.toEpochMillis(fyiSentAt(right)) ||
      left.ordinal - right.ordinal,
  );
  const rendered: Array<FyiItem> = [];
  const parts = [header];
  let used = header.length;
  for (const item of ordered) {
    const element = fyiElement(item);
    const cost = SEPARATOR.length + element.length;
    if ((rendered.length > 0 || !atLeastOne) && used + cost > budget) continue;
    rendered.push(item);
    parts.push(element);
    used += cost;
  }
  return { rendered, parts, left: ordered.length - rendered.length };
};

/** For a turn's prompt: always at least one entry, and a trailer counts the rest. */
export function renderForTurn(waiting: ReadonlyArray<FyiItem>): RenderedFyi {
  const { rendered, parts, left } = fit(
    waiting,
    "FYI messages for you. No action is needed. Use one only if it changes your current work.",
    FYI_TURN_BUDGET_CHARS,
    true,
  );
  if (rendered.length === 0) return { text: "", rendered };
  if (left > 0) {
    parts.push(
      left === 1
        ? "1 more FYI message waits for later."
        : `${left} more FYI messages wait for later.`,
    );
  }
  return { text: parts.join(SEPARATOR), rendered };
}

/** For the next model request of a running turn. */
export function renderForToolBatch(waiting: ReadonlyArray<FyiItem>): RenderedFyi {
  const { rendered, parts } = fit(
    waiting,
    "FYI messages arrived during your turn. No action is needed. Use them only if they change your current work.",
    FYI_TOOL_BATCH_BUDGET_CHARS,
    false,
  );
  return { text: rendered.length === 0 ? "" : parts.join(SEPARATOR), rendered };
}

/** Why an FYI post is refused, or `undefined` when it may wait for the thread's next turn. */
export function fyiPostRefusal(
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
): string | undefined {
  return command.freshContext === true ||
    command.attachments.length > 0 ||
    command.notification !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.fyiWake === true ||
    command.text.length > FYI_TEXT_MAX_CHARS
    ? `An FYI message is plain text of at most ${FYI_TEXT_MAX_CHARS} characters that starts no turn.`
    : undefined;
}

/**
 * Its ids come from the sender's request id and outlive the receipt. A queued message has no
 * turn item yet; a compacted thread reads no messages of its older runs, but every turn item.
 */
export const fyiAlreadyPosted = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  messageId: MessageId,
  itemId: TurnItemId,
): boolean =>
  projection.messages.some((message) => message.id === messageId) ||
  projection.turnItems.some((item) => item.id === itemId);

/** The message and runless item an FYI post writes; the item waits where it was sent. */
export function waitingFyi(input: {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
  readonly itemId: TurnItemId;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): { readonly message: OrchestrationV2ConversationMessage; readonly item: FyiItem } {
  const { command, now } = input;
  const shared = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
    ...(command.linkedSender === undefined ? {} : { linkedSender: command.linkedSender }),
    fyi: true,
    threadId: command.threadId,
    runId: null,
    nodeId: null,
    text: command.text,
    ...(command.context ? { context: command.context } : {}),
    attachments: [],
    updatedAt: now,
  } as const;
  return {
    message: {
      ...shared,
      id: command.messageId,
      role: "user",
      streaming: false,
      createdAt: now,
    },
    item: {
      ...shared,
      id: input.itemId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: input.ordinal,
      status: "pending",
      title: null,
      startedAt: now,
      completedAt: null,
      type: "user_message",
      messageId: command.messageId,
      inputIntent: "steer",
    },
  };
}

const FYI_WAKE_AFTER_MS = 6 * 60 * 60 * 1_000;

/** Run statuses that hold no turn. */
export const ENDED_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
] as const satisfies ReadonlyArray<OrchestrationV2Run["status"]>;

const ended: ReadonlySet<OrchestrationV2Run["status"]> = new Set(ENDED_RUN_STATUSES);

/** What the wake decision needs from a thread's runs. */
export interface FyiWakeRuns {
  /** A run that holds the thread now, so it is not idle. */
  readonly busy: "live_run" | "queued_run" | undefined;
  /** The latest `completedAt ?? startedAt ?? requestedAt` over every run. */
  readonly lastActivity: DateTime.Utc | undefined;
}

const latest = (first: DateTime.Utc, ...rest: ReadonlyArray<DateTime.Utc | null | undefined>) =>
  rest.reduce<DateTime.Utc>(
    (max, next) => (next != null && DateTime.isGreaterThan(next, max) ? next : max),
    first,
  );

export function wakeRuns(
  runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "status" | "requestedAt" | "startedAt" | "completedAt">
  >,
): FyiWakeRuns {
  return {
    busy: runs.some((run) => run.status === "queued")
      ? "queued_run"
      : runs.some((run) => !ended.has(run.status))
        ? "live_run"
        : undefined,
    lastActivity: runs.reduce<DateTime.Utc | undefined>((max, run) => {
      const activity = run.completedAt ?? run.startedAt ?? run.requestedAt;
      return max === undefined ? activity : latest(max, activity);
    }, undefined),
  };
}

export interface FyiWakeFacts {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "archivedAt" | "deletedAt" | "settledOverride" | "createdAt" | "snoozedUntil"
  >;
  readonly fyiWaiting: boolean;
  readonly runs: FyiWakeRuns;
  readonly limitResetAt: DateTime.Utc | undefined;
  /** A runtime request waits for the user's answer; the wake's message would read as one. */
  readonly pendingRequest: boolean;
  readonly providerEnabled: boolean;
  readonly now: DateTime.Utc;
}

export type FyiWakeDecision =
  | { readonly due: true; readonly idleFrom: DateTime.Utc }
  | {
      readonly due: false;
      readonly reason:
        | "nothing_waiting"
        | "deleted"
        | "archived"
        | "settled"
        | "live_run"
        | "queued_run"
        | "pending_request"
        | "provider_disabled";
    }
  | { readonly due: false; readonly reason: "not_yet"; readonly dueAt: DateTime.Utc };

/**
 * A thread with an FYI waiting is woken once it has been idle 6 hours, and not before its snooze
 * ends. Idle hours count from `idleFrom`: the latest of its creation, its runs' last activity and,
 * while a usage limit failed its latest run on the provider it still uses, the later of that
 * limit's reset and the snooze end, when the limited agent and its armed resume may run again.
 */
export function decideWake(facts: FyiWakeFacts): FyiWakeDecision {
  const { thread } = facts;
  if (!facts.fyiWaiting) return { due: false, reason: "nothing_waiting" };
  if (thread.deletedAt !== null) return { due: false, reason: "deleted" };
  if (thread.archivedAt !== null) return { due: false, reason: "archived" };
  if (thread.settledOverride === "settled") return { due: false, reason: "settled" };
  if (facts.runs.busy !== undefined) return { due: false, reason: facts.runs.busy };
  if (facts.pendingRequest) return { due: false, reason: "pending_request" };
  if (!facts.providerEnabled) return { due: false, reason: "provider_disabled" };
  const idleFrom = latest(
    thread.createdAt,
    facts.runs.lastActivity,
    facts.limitResetAt === undefined ? undefined : latest(facts.limitResetAt, thread.snoozedUntil),
  );
  const dueAt = latest(
    DateTime.add(idleFrom, { milliseconds: FYI_WAKE_AFTER_MS }),
    thread.snoozedUntil,
  );
  return DateTime.isGreaterThan(dueAt, facts.now)
    ? { due: false, reason: "not_yet", dueAt }
    : { due: true, idleFrom };
}

/** The orchestrator's wake gate: `decideWake` on a thread's command projection. */
export function fyiWakeGate(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "turnItems" | "runtimeRequests"
  >;
  readonly settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0];
  readonly now: DateTime.Utc;
}): FyiWakeDecision {
  const { projection } = input;
  const run = latestExecutedRun(projection.runs);
  const failure =
    run?.providerInstanceId === projection.thread.providerInstanceId
      ? latestRootProviderFailure(run, projection.turnItems)
      : null;
  return decideWake({
    thread: projection.thread,
    fyiWaiting: waitingFyiItems(projection).length > 0,
    runs: wakeRuns(projection.runs),
    limitResetAt:
      failure?.class === "usage_limit" && failure.resetAt != null
        ? DateTime.makeUnsafe(failure.resetAt)
        : undefined,
    pendingRequest: projection.runtimeRequests.some((request) => request.status === "pending"),
    providerEnabled: resolveProjectProviderInstanceEnabled(
      input.settings,
      projection.thread.projectId,
      projection.thread.modelSelection.instanceId,
    ),
    now: input.now,
  });
}

export const FYI_WAKE_TEXT =
  "This thread was idle for 6 hours with FYI messages waiting, so T3 Code woke it to deliver them. They are above. No action is needed. If none changes your work, reply in one line and stop.";

/** Its ids come from the thread and `idleFrom`, so one idle period gets one wake. */
export function wakeCommand(
  threadId: ThreadId,
  idleFrom: DateTime.Utc,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> {
  const key = `${threadId}:${DateTime.formatIso(idleFrom)}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`command:fyi-wake:${key}`),
    threadId,
    messageId: MessageId.make(`message:fyi-wake:${key}`),
    text: FYI_WAKE_TEXT,
    attachments: [],
    notification: {
      source: { kind: "fyi" },
      outcome: "updated",
      summary: "Idle 6 hours with FYI messages waiting",
      detail: FYI_WAKE_TEXT,
    },
    fyiWake: true,
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  };
}
