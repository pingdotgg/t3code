import {
  latestExecutedRun,
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitBlockedRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  latestProviderTurnForAttempt,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderGoal,
  type OrchestrationV2ProviderSession,
  type ServerProvider,
  type ServerProviderModel,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2ThreadProjection,
  orchestrationV2RunWorkStartedAt,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentLabel,
  getProviderOptionStatedValue,
  resolveSelectableModel,
  withLegacyUltracodeEffort,
} from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
  type ThreadStructure,
  type ThreadStructureRuntime,
  type ThreadStructureTurnItem,
} from "./models.ts";
import { commandDisplayText } from "../work-log/commandLabel.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";
import { mFallback, msg } from "gt-i18n";
import { markedTextEnglish } from "../errors/translatable.ts";
import type { MFunctionType } from "gt-i18n/types";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);
// Preparing runs show their workspace setup instead.
const PROVIDER_STARTING_RUN_STATUSES = new Set(["starting", "running"]);

const EMPTY_EXTENSION_STATUSES: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]> =
  [];

/** Only the selected provider's current session can supply transient extension status. */
export function deriveProviderExtensionStatuses(
  projection:
    | (Pick<ThreadStructure, "thread"> & {
        readonly providerThreads: ReadonlyArray<
          Pick<
            ThreadStructure["providerThreads"][number],
            "id" | "providerSessionId" | "providerInstanceId"
          >
        >;
        readonly providerSessions: ReadonlyArray<
          Pick<
            OrchestrationV2ProviderSession,
            "id" | "providerInstanceId" | "status" | "extensionStatuses"
          >
        >;
      })
    | null,
) {
  if (projection === null) return EMPTY_EXTENSION_STATUSES;
  const instanceId = projection.thread.modelSelection.instanceId;
  const activeThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  if (activeThread !== undefined && activeThread.providerInstanceId !== instanceId)
    return EMPTY_EXTENSION_STATUSES;
  const session = projection.providerSessions.findLast(
    (session) =>
      session.providerInstanceId === instanceId &&
      (activeThread === undefined || session.id === activeThread.providerSessionId),
  );
  return session === undefined || session.status === "stopped"
    ? EMPTY_EXTENSION_STATUSES
    : (session.extensionStatuses ?? EMPTY_EXTENSION_STATUSES);
}

function latestMatchingRun(
  projection: ThreadStructure,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function providerStarting(
  projection: ThreadStructure,
  run: OrchestrationV2ThreadProjection["runs"][number],
): Pick<ThreadRunSummary, "providerStartingLabel" | "providerStartingLabelMsg"> {
  const driver = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === run.providerInstanceId,
  )?.driver;
  const name = driver === undefined ? undefined : PROVIDER_DISPLAY_NAMES[driver];
  const label =
    name === undefined
      ? msg("Starting", { $context: "a provider is launching" })
      : msg("Starting {provider}", { provider: name });
  return { providerStartingLabel: markedTextEnglish([label]), providerStartingLabelMsg: label };
}

function summarizeThreadRun(
  projection: ThreadStructure,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  const turnStatus = ACTIVITY_RUN_STATUSES.has(run.status)
    ? latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status
    : undefined;
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    // A run counts as running before its provider opens; until a turn appears,
    // the provider can still be launching for minutes.
    ...(turnStatus === undefined
      ? PROVIDER_STARTING_RUN_STATUSES.has(run.status)
        ? providerStarting(projection, run)
        : {}
      : turnStatus === "pending" || turnStatus === "running"
        ? {}
        : { turnEnded: true }),
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

function presentedUsageLimitRun(
  projection: ThreadStructure,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  return usageLimitRunPresentedAsLatest(
    projection.runs,
    projection.turnItems,
    providerSession?.lastError ?? null,
  );
}

function presentedLatestRun(
  projection: ThreadStructure,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return presentedUsageLimitRun(projection) ?? latestUnheldRun(projection.runs);
}

export function deriveLatestThreadRun(projection: ThreadStructure): ThreadRunSummary | null {
  const run = presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

export function deriveThreadActivityRun(projection: ThreadStructure): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Provider-native subagent threads never get app runs: their work is a runless
 * root turn whose status follows the subagent.
 */
export function deriveRunlessWorkStartedAt(projection: ThreadStructure): string | null {
  const status = deriveProviderSubagentStatus(projection);
  return status !== null && isOrchestrationV2WorkActive(status.status) ? status.startedAt : null;
}

export interface ProviderSubagentStatus {
  readonly status: OrchestrationV2ExecutionNode["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export function deriveProviderSubagentStatus(
  projection: ThreadStructure,
): ProviderSubagentStatus | null {
  if (!isProviderNativeSubagentThread(projection.thread)) return null;
  const node = projection.nodes.findLast(
    (candidate) => candidate.kind === "root_turn" && candidate.runId === null,
  );
  if (node === undefined) return null;
  return {
    status: node.status,
    startedAt: node.startedAt === null ? null : DateTime.formatIso(node.startedAt),
    completedAt: node.completedAt === null ? null : DateTime.formatIso(node.completedAt),
  };
}

export function deriveReportedModelSelection(projection: ThreadStructure): ModelSelection | null {
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  return providerThread?.nativeMetadata?.modelSelection ?? null;
}

export const REASONING_EFFORT_OPTION_IDS: ReadonlyArray<string> = [
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
];

export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const options = withLegacyUltracodeEffort(caps.optionDescriptors, selection.options);
  const current = options ? { ...selection, options } : selection;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = caps.optionDescriptors?.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const value = getProviderOptionStatedValue(id, current, reportedSelection);
    if (value === undefined && id !== "variant") continue;
    if (typeof value === "boolean") continue;
    // Bypass picker normalization so an obsolete choice cannot become a catalog default.
    const label = getProviderOptionCurrentLabel(
      { ...descriptor, currentValue: value },
      current,
      reportedSelection,
    );
    if (label) return label;
  }
  return null;
}

/** A reported model the picker catalog does not know, such as `claude-opus-5[1m]`, keeps its raw effort. */
export function formatSubagentEffort(input: {
  readonly modelSlug: string | null;
  readonly modelSelection: ModelSelection | undefined;
  readonly provider: Pick<ServerProvider, "driver" | "models"> | undefined;
}): string | null {
  const { modelSlug, modelSelection: selection, provider } = input;
  if (!provider || !selection || !modelSlug) return null;
  const selectionSlug =
    resolveSelectableModel(provider.driver, selection.model, provider.models) ??
    selection.model.trim();
  if (selectionSlug !== modelSlug) return null;
  if (provider.models.some((model) => model.slug === modelSlug)) {
    return formatModelSelectionEffort({ ...selection, model: modelSlug }, provider.models);
  }
  return (
    REASONING_EFFORT_OPTION_IDS.map((id) => getModelSelectionStringOptionValue(selection, id)).find(
      Boolean,
    ) ?? null
  );
}

const SUBAGENT_STATUS_LABELS: Record<OrchestrationV2ExecutionNode["status"], string> = {
  idle: msg("Idle"),
  pending: msg("Working"),
  running: msg("Working"),
  waiting: msg("Waiting"),
  completed: msg("Completed"),
  interrupted: msg("Interrupted"),
  failed: msg("Failed"),
  cancelled: msg("Cancelled"),
  rolled_back: msg("Cancelled"),
};

export function formatProviderSubagentStatus(
  status: ProviderSubagentStatus | null,
  nowMs: number,
  resolve: MFunctionType = mFallback,
): string {
  if (status === null) return resolve(msg("Starting"));
  const label = resolve(SUBAGENT_STATUS_LABELS[status.status]);
  const live = isOrchestrationV2WorkActive(status.status);
  if (!live && status.status !== "completed") return label;
  const start = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt);
  const end = live
    ? nowMs
    : status.completedAt === null
      ? Number.NaN
      : Date.parse(status.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live
    ? resolve(msg("{label} {elapsed}", { label, elapsed }))
    : resolve(msg("{label} in {elapsed}", { label, elapsed }));
}

/** The run a manual continuation resumes; the server holds the queue until it does. */
export function deriveResumableRunId(
  projection: Pick<ThreadStructure, "runs" | "turnItems">,
  runtime: Pick<ThreadStructureRuntime, "lastErrorClass"> | null,
): RunId | null {
  const run =
    usageLimitBlockedRun(projection.runs, projection.turnItems, null) ??
    latestExecutedRun(projection.runs);
  if (run?.status === "interrupted") return run.id;
  return run?.status === "failed" &&
    runtime?.lastErrorClass === "usage_limit" &&
    latestRootProviderFailure(run, projection.turnItems)?.class === "usage_limit"
    ? run.id
    : null;
}

/**
 * Whether Resume can start: the run's continuation, else the held queue. The server refuses that
 * continuation while any request is pending, so the queue must not be released in its place.
 */
export function canResumeThread(
  projection: Pick<ThreadStructure, "runtimeRequests">,
  resumableRunId: RunId | null,
  queueHeld: boolean,
): boolean {
  if (resumableRunId === null) return queueHeld;
  return !projection.runtimeRequests.some((request) => request.status === "pending");
}

export function deriveThreadRuntime(
  projection: ThreadStructure & Pick<OrchestrationV2ThreadProjection, "updatedAt">,
): ThreadRuntimeSummary | null {
  const runtime = deriveThreadStructureRuntime(projection);
  return runtime === null
    ? null
    : { ...runtime, updatedAt: DateTime.formatIso(projection.updatedAt) };
}

/** The runtime summary a thread's structure determines: all of it but `updatedAt`. */
export function deriveThreadStructureRuntime(
  projection: ThreadStructure,
): ThreadStructureRuntime | null {
  const latestRun = deriveLatestThreadRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  const usageLimitedRun = presentedUsageLimitRun(projection);
  const latestRunProjection = presentedLatestRun(projection);
  const activityRun = deriveThreadActivityRun(projection);
  const liveActivityRun = latestMatchingRun(projection, (run) =>
    ACTIVITY_RUN_STATUSES.has(run.status),
  );
  const backgroundWorkHoldsRun = backgroundWorkHoldsCompletion(
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  );
  // A pull request watch can hold a thread that never ran.
  if (latestRun === null && !backgroundWorkHoldsRun) return null;
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  return {
    status: usageLimitedRun
      ? "failed"
      : backgroundWorkHoldsRun && latestRunProjection?.status !== "failed"
        ? "idle"
        : (activityRun?.status ?? "idle"),
    activeRunId,
    activityStartedAt:
      liveActivityRun === null
        ? null
        : DateTime.formatIso(orchestrationV2RunWorkStartedAt(liveActivityRun)),
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    ...threadErrorSummary(
      latestRootProviderFailure(latestRunProjection, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
  };
}

export interface UsageLimitNoticeRows {
  readonly itemIds: ReadonlySet<ThreadStructureTurnItem["id"]>;
  /** Hidden only when its text reads as the provider's limit message; see PROVIDER_LIMIT_NOTICE. */
  readonly providerNoticeItemId: ThreadStructureTurnItem["id"] | null;
}

// Claude Code's own limit messages, such as "You've hit your 5-hour limit · resets 7:10am".
const PROVIDER_LIMIT_NOTICE =
  /^(?:You[’']ve hit your (?:(?:5-hour|session|weekly|usage) )?limit|You[’']re out of extra usage|Claude AI usage limit reached)(?: · resets (?:[1-9]|1[0-2])(?::[0-5]\d)?(?:am|pm)(?: \([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*\))?)?\.?$/i;

/**
 * The timeline rows that repeat a usage-limit pause while its recovery notice shows: the run's
 * limit failure, Claude's pause notices, and the provider's own limit message. They return to
 * history once another run executes.
 */
export function deriveUsageLimitNoticeRows(
  projection: ThreadStructure,
): UsageLimitNoticeRows | null {
  const runtime = deriveThreadStructureRuntime(projection);
  const run = presentedLatestRun(projection);
  if (runtime?.status !== "failed" || runtime.lastErrorClass !== "usage_limit" || run === null) {
    return null;
  }
  const failure = latestRootProviderFailure(run, projection.turnItems);
  const itemIds = new Set<ThreadStructureTurnItem["id"]>();
  let failedProviderTurnId: ThreadStructureTurnItem["providerTurnId"] = null;
  for (const item of projection.turnItems) {
    if (item.runId !== run.id) continue;
    if (
      item.type === "error" &&
      item.status === "failed" &&
      item.nodeId === run.rootNodeId &&
      item.failure.class === "usage_limit"
    ) {
      itemIds.add(item.id);
      if (item.failure === failure) failedProviderTurnId = item.providerTurnId;
    }
  }
  let providerNotice: ThreadStructureTurnItem | null = null;
  if (failedProviderTurnId !== null) {
    for (const item of projection.turnItems) {
      if (item.runId !== run.id || item.providerTurnId !== failedProviderTurnId) continue;
      if (
        item.type === "system_notice" &&
        item.nodeId === run.rootNodeId &&
        item.parentItemId === null &&
        item.nativeItemRef?.driver === "claudeAgent" &&
        item.nativeItemRef.nativeId?.startsWith(`usage-limit:${failedProviderTurnId}:`) === true
      ) {
        itemIds.add(item.id);
      }
      if (
        item.type === "assistant_message" &&
        item.parentItemId === null &&
        (providerNotice === null || item.ordinal > providerNotice.ordinal)
      ) {
        providerNotice = item;
      }
    }
  }
  return { itemIds, providerNoticeItemId: providerNotice?.id ?? null };
}

export function withoutUsageLimitNoticeRows<
  Row extends OrchestrationV2ThreadProjection["visibleTurnItems"][number],
>(rows: ReadonlyArray<Row>, notice: UsageLimitNoticeRows | null): ReadonlyArray<Row> {
  if (notice === null) return rows;
  const hidden = ({ item }: Row) =>
    notice.itemIds.has(item.id) ||
    (item.id === notice.providerNoticeItemId &&
      item.type === "assistant_message" &&
      PROVIDER_LIMIT_NOTICE.test(item.text.trim()));
  return rows.some(hidden) ? rows.filter((row) => !hidden(row)) : rows;
}

/** Whether a usage-limit recovery holds the thread's snooze, so its notice offers Wake now. */
export function limitRecoveryOwnsSnooze(input: {
  readonly runId: RunId | null | undefined;
  readonly resetAt: string | null | undefined;
  readonly recovery: OrchestrationV2LimitRecovery | null | undefined;
  readonly snoozedUntil: string | null | undefined;
}): boolean {
  const { runId, resetAt, recovery, snoozedUntil } = input;
  return (
    recovery?.snooze === true &&
    runId != null &&
    recovery.runId === runId &&
    resetAt != null &&
    recovery.resetAt === resetAt &&
    snoozedUntil != null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt)
  );
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadStructureRuntime | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

const BACKGROUND_WORK_KINDS: Record<
  BackgroundWorkKind,
  { readonly order: number; readonly singular: string; readonly count: string }
> = {
  subagent: {
    order: 0,
    singular: msg("subagent"),
    count: msg("{count, plural, one {{count} subagent} other {{count} subagents}}"),
  },
  command: {
    order: 1,
    singular: msg("command"),
    count: msg("{count, plural, one {{count} command} other {{count} commands}}"),
  },
  monitor: {
    order: 2,
    singular: msg("monitor"),
    count: msg("{count, plural, one {{count} monitor} other {{count} monitors}}"),
  },
  background_task: {
    order: 3,
    singular: msg("background task"),
    count: msg("{count, plural, one {{count} background task} other {{count} background tasks}}"),
  },
};

export interface RunStopPresentation {
  /** `unresponsive`: the provider did not confirm the stop in time, so Force stop is offered. */
  readonly state: "stopping" | "unresponsive";
  readonly runId: ThreadStructure["runs"][number]["id"];
  readonly requestedAt: string;
  /** The run already ended; the Stop targeted its background work. */
  readonly background: boolean;
}

/**
 * A Stop the provider has not finished yet. It stays `stopping` while the agent winds down,
 * since some providers confirm the request before the turn actually ends. On a run that
 * already ended, only an unanswered Stop of its background work counts.
 */
export function presentRunStop(
  projection: Pick<ThreadStructure, "runs" | "turnItems">,
): RunStopPresentation | null {
  let active: ThreadStructure["runs"][number] | null = null;
  let latest: ThreadStructure["runs"][number] | null = null;
  for (const candidate of projection.runs) {
    // Queued follow-ups never ran, so they hold no Stop of their own.
    if (candidate.status !== "queued" && candidate.ordinal > (latest?.ordinal ?? -1))
      latest = candidate;
    if (
      INTERRUPTIBLE_RUN_STATUSES.has(candidate.status) &&
      candidate.ordinal > (active?.ordinal ?? -1)
    )
      active = candidate;
  }
  const run = active ?? latest;
  if (run === null) return null;
  let request:
    | Extract<ThreadStructure["turnItems"][number], { type: "run_interrupt_request" }>
    | undefined;
  for (const item of projection.turnItems) {
    if (item.runId !== run.id) continue;
    if (item.type === "run_interrupt_result") return null;
    if (item.type === "run_interrupt_request") request = item;
  }
  if (request === undefined || (active === null && request.unresponsiveAt === undefined))
    return null;
  return {
    state: request.unresponsiveAt === undefined ? "stopping" : "unresponsive",
    runId: run.id,
    requestedAt: DateTime.formatIso(request.startedAt ?? request.updatedAt),
    background: active === null,
  };
}

export interface PendingBackgroundWorkItem {
  readonly taskId: string;
  readonly kind: BackgroundWorkKind;
  readonly label: string;
  readonly childThreadId: ThreadId | undefined;
}

export interface PendingBackgroundWorkPresentation {
  readonly title: string;
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  readonly waiting: boolean;
}

function joinWithAnd(parts: ReadonlyArray<string>, resolve: MFunctionType): string {
  if (parts.length <= 1) return parts.join("");
  return resolve(
    msg("{items} and {last}", { items: parts.slice(0, -1).join(", "), last: parts.at(-1)! }),
  );
}

// The Claude adapter forces a stuck query closed after 10 seconds.
export const BACKGROUND_WORK_STOP_RETRY_AFTER_MS = 10_000;

export interface BackgroundWorkStopRequest {
  readonly threadKey: string;
  readonly taskIds: ReadonlyArray<string>;
  readonly retryAt: number | null;
}

/** Acceptance does not end the tasks, so an accepted Stop stays pending while they are listed. */
export function isBackgroundWorkStopPending(
  request: BackgroundWorkStopRequest | null,
  threadKey: string,
  tasks: ReadonlyArray<Pick<OrchestrationV2PendingBackgroundTask, "taskId">>,
  retryExpired: boolean,
): boolean {
  if (request === null || request.threadKey !== threadKey || retryExpired) return false;
  return request.retryAt === null || tasks.some((task) => request.taskIds.includes(task.taskId));
}

export function presentPendingBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  resolve: MFunctionType = mFallback,
): PendingBackgroundWorkPresentation | null {
  if (tasks.length === 0) return null;
  const waiting = backgroundWorkHoldsCompletion(tasks);
  const items = tasks
    .map((task): PendingBackgroundWorkItem => {
      const description = task.description?.trim();
      const label =
        description === undefined
          ? undefined
          : task.kind === "subagent"
            ? formatSubagentDisplayTitle(description).trim()
            : task.kind === "command" || task.kind === "monitor"
              ? commandDisplayText(description)
              : description;
      return {
        taskId: task.taskId,
        kind: task.kind,
        label:
          label === undefined || label.length === 0
            ? resolve(BACKGROUND_WORK_KINDS[task.kind].singular)
            : label,
        childThreadId: task.kind === "subagent" ? task.childThreadId : undefined,
      };
    })
    // `map` returned a new array; Hermes has no `toSorted`.
    .sort(
      (left, right) =>
        BACKGROUND_WORK_KINDS[left.kind].order - BACKGROUND_WORK_KINDS[right.kind].order,
    );
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const noun = resolve(BACKGROUND_WORK_KINDS[only.kind].singular);
    const named = only.label !== noun;
    const title = named
      ? waiting
        ? resolve(msg("Waiting · {label}", { label: only.label }))
        : resolve(msg("Running · {label}", { label: only.label }))
      : backgroundWorkSingleTitle(only.kind, waiting, resolve);
    return { title, items, waiting };
  }
  const counts = new Map<BackgroundWorkKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = joinWithAnd(
    Array.from(counts, ([kind, count]) => resolve(BACKGROUND_WORK_KINDS[kind].count, { count })),
    resolve,
  );
  return {
    title: waiting
      ? resolve(msg("Waiting on {groups}", { groups }))
      : resolve(msg("Running {groups}", { groups })),
    items,
    waiting,
  };
}

function backgroundWorkSingleTitle(
  kind: BackgroundWorkKind,
  waiting: boolean,
  resolve: MFunctionType,
): string {
  switch (kind) {
    case "subagent":
      return waiting ? resolve(msg("Waiting on a subagent")) : resolve(msg("Running a subagent"));
    case "command":
      return waiting ? resolve(msg("Waiting on a command")) : resolve(msg("Running a command"));
    case "monitor":
      return waiting ? resolve(msg("Waiting on a monitor")) : resolve(msg("Running a monitor"));
    case "background_task":
      return waiting
        ? resolve(msg("Waiting on a background task"))
        : resolve(msg("Running a background task"));
  }
}

export interface ProviderGoalPresentation {
  readonly title: string;
  readonly objective: string;
  readonly usage: string | null;
  readonly canResume: boolean;
}

const PROVIDER_GOAL_TITLES: Record<OrchestrationV2ProviderGoal["status"], string> = {
  active: msg("Pursuing goal"),
  paused: msg("Goal paused"),
  blocked: msg("Goal blocked"),
  usage_limited: msg("Goal hit a usage limit"),
  budget_limited: msg("Goal reached its token budget"),
  complete: msg("Goal complete"),
};

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  const thousands = Math.round(tokens / 1_000);
  if (thousands < 1_000) return `${thousands}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function presentProviderGoal(
  goal: OrchestrationV2ProviderGoal,
  working: boolean,
  resolve: MFunctionType = mFallback,
): ProviderGoalPresentation {
  const usage: Array<string> = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) {
    usage.push(
      goal.tokenBudget == null
        ? resolve(msg("{used} tokens", { used: formatGoalTokens(goal.tokensUsed) }))
        : resolve(
            msg("{used} / {budget} tokens", {
              used: formatGoalTokens(goal.tokensUsed),
              budget: formatGoalTokens(goal.tokenBudget),
            }),
          ),
    );
  }
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) {
    usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  if (goal.checks !== undefined && goal.checks > 0) {
    usage.push(
      resolve(
        msg("{count, plural, one {{count} check} other {{count} checks}}", { count: goal.checks }),
      ),
    );
  }
  return {
    title:
      goal.status === "active" && !working
        ? resolve(msg("Goal set"))
        : resolve(PROVIDER_GOAL_TITLES[goal.status]),
    objective: goal.objective,
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}

export function notificationChildThreadId(
  source: OrchestrationV2NotificationSource,
): ThreadId | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
      return source.childThreadId;
    case "command":
    case "monitor":
    case "background_task":
    case "system":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
