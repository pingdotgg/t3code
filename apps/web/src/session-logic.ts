import {
  ProviderDriverKind,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type PlanId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  ThreadCheckpointSummary,
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadProposedPlan,
  ThreadRunSummary,
  ThreadRuntimeSummary,
  ThreadTodoPlan,
  ThreadWorkEntry,
} from "@t3tools/client-runtime/state/shell";

import type { ChatMessage, ProposedPlan, SessionPhase, TurnDiffSummary } from "./types";
import * as DateTime from "effect/DateTime";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  { value: ProviderDriverKind.make("grok"), label: "Grok", available: true },
];

export type WorkLogToolLifecycleStatus = ThreadWorkEntry["toolLifecycleStatus"];

export interface WorkLogEntry extends Omit<
  ThreadWorkEntry,
  "structuredPayload" | "runId" | "itemType" | "toolLifecycleStatus"
> {
  readonly runId?: RunId | null;
  readonly itemType?: ThreadWorkEntry["itemType"];
  readonly toolLifecycleStatus?: ThreadWorkEntry["toolLifecycleStatus"];
  readonly structuredPayload?: ThreadWorkEntry["structuredPayload"];
  readonly sourceItemType?: ThreadWorkEntry["itemType"];
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
}

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

export interface ActivePlanState {
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly explanation?: string | null;
  readonly steps: Array<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  readonly id: PlanId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runId: RunId | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: ThreadId | null;
  readonly status: ThreadProposedPlan["status"];
}

export type TimelineAttempt = Pick<
  OrchestrationV2RunAttempt,
  "id" | "runId" | "attemptOrdinal" | "rootNodeId" | "status"
>;

export type TimelineEntry = (
  | {
      readonly id: string;
      readonly kind: "message";
      readonly createdAt: string;
      readonly message: ChatMessage;
      readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
    }
  | {
      readonly id: string;
      readonly kind: "proposed-plan";
      readonly createdAt: string;
      readonly proposedPlan: ProposedPlan;
    }
  | {
      readonly id: string;
      readonly kind: "work";
      readonly createdAt: string;
      readonly entry: WorkLogEntry;
    }
  | {
      readonly id: string;
      readonly kind: "event";
      readonly createdAt: string;
      readonly projectedItem: OrchestrationV2ProjectedTurnItem;
    }
) & {
  /** V2 identity resolved from the item's execution node, when locally available. */
  readonly attempt?: TimelineAttempt;
};

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "tool" ||
    entry.tone === "thinking" ||
    entry.tone === "error" ||
    entry.command !== undefined ||
    entry.requestKind !== undefined
  );
}

export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  );
}

export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  return workLogEntryIsToolLike(entry) && entry.toolLifecycleStatus === "completed";
}

export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    !workEntryIndicatesToolSuccess(entry)
  );
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) return null;
  return formatDuration(endedAt - startedAt);
}

export function isLatestRunSettled(
  latestRun: Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null,
): boolean {
  if (latestRun === null) return false;
  if (
    latestRun.status === "preparing" ||
    latestRun.status === "starting" ||
    latestRun.status === "running" ||
    latestRun.status === "waiting"
  )
    return false;
  return runtime?.activeRunId !== latestRun.runId;
}

export function deriveActiveWorkStartedAt(
  latestRun: Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null,
  sendStartedAt: string | null,
): string | null {
  if (runtime?.activeRunId !== null && runtime?.activeRunId !== undefined) {
    return latestRun?.runId === runtime.activeRunId
      ? (latestRun.startedAt ?? sendStartedAt)
      : sendStartedAt;
  }
  return isLatestRunSettled(latestRun, runtime)
    ? sendStartedAt
    : (latestRun?.startedAt ?? sendStartedAt);
}

export function derivePendingApprovals(
  approvals: ReadonlyArray<ThreadPendingApproval>,
): ThreadPendingApproval[] {
  return [...approvals].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function derivePendingUserInputs(
  inputs: ReadonlyArray<ThreadPendingUserInput>,
): ThreadPendingUserInput[] {
  return [...inputs].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function deriveActivePlanState(
  plans: ReadonlyArray<ThreadTodoPlan>,
  latestRunId: RunId | undefined,
): ActivePlanState | null {
  const plan =
    [...plans].toReversed().find((candidate) => candidate.runId === latestRunId) ??
    plans.at(-1) ??
    null;
  if (plan === null || plan.steps.length === 0) return null;
  return {
    createdAt: plan.updatedAt,
    runId: plan.runId,
    explanation: plan.explanation,
    steps: plan.steps.map(({ step, status }) => ({ step, status })),
  };
}

function toLatestProposedPlanState(plan: ThreadProposedPlan): LatestProposedPlanState {
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    runId: plan.runId,
    planMarkdown: plan.planMarkdown,
    implementedAt: plan.implementedAt,
    implementationThreadId: plan.implementationThreadId,
    status: plan.status,
  };
}

export function findLatestProposedPlan(
  plans: ReadonlyArray<ThreadProposedPlan>,
  latestRunId: RunId | string | null | undefined,
): LatestProposedPlanState | null {
  const candidates = latestRunId ? plans.filter((plan) => plan.runId === latestRunId) : plans;
  const plan = [...(candidates.length > 0 ? candidates : plans)]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  return plan === undefined ? null : toLatestProposedPlanState(plan);
}

export function findSidebarProposedPlan(input: {
  readonly threads: ReadonlyArray<
    Pick<
      { readonly id: ThreadId; readonly proposedPlans: ReadonlyArray<ThreadProposedPlan> },
      "id" | "proposedPlans"
    >
  >;
  readonly latestRun: Pick<ThreadRunSummary, "runId" | "sourcePlanRef"> | null;
  readonly latestRunSettled: boolean;
  readonly threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  if (!input.latestRunSettled && input.latestRun?.sourcePlanRef !== undefined) {
    const source = input.latestRun.sourcePlanRef;
    const plan = input.threads
      .find((thread) => thread.id === source.threadId)
      ?.proposedPlans.find((candidate) => candidate.id === source.planId);
    if (plan !== undefined) return toLatestProposedPlanState(plan);
  }
  const activePlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];
  return findLatestProposedPlan(activePlans, input.latestRun?.runId);
}

export function hasActionableProposedPlan(
  plan: LatestProposedPlanState | Pick<ThreadProposedPlan, "implementedAt"> | null,
): boolean {
  return plan !== null && plan.implementedAt === null;
}

export function deriveWorkLogEntries(entries: ReadonlyArray<ThreadWorkEntry>): WorkLogEntry[] {
  return entries.map((entry) => ({ ...entry, sourceItemType: entry.itemType }));
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ThreadProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
): TimelineEntry[] {
  return [
    ...messages.map(
      (message): TimelineEntry => ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      }),
    ),
    ...proposedPlans.map(
      (proposedPlan): TimelineEntry => ({
        id: proposedPlan.id,
        kind: "proposed-plan",
        createdAt: proposedPlan.createdAt,
        proposedPlan,
      }),
    ),
    ...workEntries.map(
      (entry): TimelineEntry => ({
        id: entry.id,
        kind: "work",
        createdAt: entry.createdAt,
        entry,
      }),
    ),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

const STANDALONE_V2_ITEM_TYPES = new Set<OrchestrationV2ProjectedTurnItem["item"]["type"]>([
  "approval_request",
  "compaction",
  "error",
  "fork",
  "handoff",
  "run_interrupt_request",
  "run_interrupt_result",
  "subagent",
  "thread_created",
  "user_input_request",
]);

const PERSISTENT_RESOURCE_V2_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "fork",
  "subagent",
  "thread_created",
]);

export function timelineEntryIsPersistentResourceCard(entry: TimelineEntry): boolean {
  return (
    entry.kind === "event" && PERSISTENT_RESOURCE_V2_ITEM_TYPES.has(entry.projectedItem.item.type)
  );
}

function projectedItemCreatedAt(row: OrchestrationV2ProjectedTurnItem): string {
  return DateTime.formatIso(row.item.startedAt ?? row.item.updatedAt);
}

function projectedWorkEntryStatus(
  item: OrchestrationV2TurnItem,
): NonNullable<WorkLogEntry["toolLifecycleStatus"]> {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function projectedWorkEntryTone(item: OrchestrationV2TurnItem): WorkLogEntry["tone"] {
  if (item.status === "failed") return "error";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}

function projectedWorkEntry(row: OrchestrationV2ProjectedTurnItem): WorkLogEntry {
  const { item } = row;
  const title = item.title?.trim() || null;
  const common = {
    id: item.id,
    createdAt: projectedItemCreatedAt(row),
    runId: item.runId,
    tone: projectedWorkEntryTone(item),
    itemType: item.type,
    toolLifecycleStatus: projectedWorkEntryStatus(item),
    structuredPayload: item,
    projectedItem: row,
  } as const;

  switch (item.type) {
    case "reasoning":
      return {
        ...common,
        label: title ?? "Thinking",
        ...(item.text ? { detail: item.text } : {}),
      };
    case "command_execution":
      return {
        ...common,
        label: title ?? "Ran command",
        command: item.input,
        rawCommand: item.input,
        ...(item.output ? { detail: item.output } : {}),
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change":
      return {
        ...common,
        label: title ?? `Changed ${item.fileName}`,
        changedFiles: [item.fileName],
        ...(item.diffStr ? { detail: item.diffStr } : {}),
        toolTitle: title ?? "File change",
        toolData: item,
      };
    case "file_search":
      return {
        ...common,
        label: title ?? "Searched files",
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search":
      return {
        ...common,
        label: title ?? "Searched the web",
        ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
        toolTitle: title ?? "Web search",
        toolData: item,
      };
    case "checkpoint":
      return {
        ...common,
        label: title ?? "Checkpoint captured",
        changedFiles: item.files.map((file) => file.path),
        toolData: item,
      };
    case "error":
      return {
        ...common,
        label: title ?? "Provider error",
        detail: item.failure.message,
        toolData: item,
      };
    case "todo_list": {
      const completed = item.steps.filter((step) => step.status === "completed").length;
      return {
        ...common,
        label: title ?? "Updated tasks",
        detail: `${completed}/${item.steps.length} completed`,
        toolData: item,
      };
    }
    case "dynamic_tool":
      return {
        ...common,
        label: title ?? item.toolName ?? "Tool call",
        toolTitle: title ?? item.toolName ?? "Tool",
        toolData: { input: item.input, output: item.output },
      };
    default:
      return {
        ...common,
        label: title ?? item.type.replaceAll("_", " "),
        toolData: item,
      };
  }
}

/**
 * Builds the web timeline in the exact order committed by `visibleTurnItems`.
 * Committed rows are presented directly from their projected item. Optimistic
 * messages are the only client-owned entries appended to that sequence.
 */
export function deriveTimelineEntriesFromVisibleTurnItems(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly optimisticMessages: ReadonlyArray<ChatMessage>;
  readonly attachmentUrlById?: ReadonlyMap<string, string>;
  readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
}): TimelineEntry[] {
  const committedMessageIds = new Set<string>();
  const entries: TimelineEntry[] = [];
  const attemptByRootNodeId = new Map(
    (input.attempts ?? []).map((attempt) => [attempt.rootNodeId, attempt] as const),
  );
  const nodeById = new Map((input.nodes ?? []).map((node) => [node.id, node] as const));

  const resolveAttempt = (item: OrchestrationV2TurnItem): TimelineAttempt | undefined => {
    if (item.nodeId === null || item.runId === null) return undefined;
    let nodeId: OrchestrationV2ExecutionNode["id"] | null = item.nodeId;
    const visited = new Set<OrchestrationV2ExecutionNode["id"]>();
    while (nodeId !== null && !visited.has(nodeId)) {
      visited.add(nodeId);
      const directAttempt = attemptByRootNodeId.get(nodeId);
      if (directAttempt?.runId === item.runId) return directAttempt;
      const node = nodeById.get(nodeId);
      if (node === undefined) return undefined;
      const rootAttempt = attemptByRootNodeId.get(node.rootNodeId);
      if (rootAttempt?.runId === item.runId) return rootAttempt;
      nodeId = node.parentNodeId;
    }
    return undefined;
  };

  for (const row of input.visibleTurnItems) {
    const { item } = row;
    const createdAt = projectedItemCreatedAt(row);
    const attempt = resolveAttempt(item);
    const attemptMetadata = attempt === undefined ? {} : { attempt };
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message: ChatMessage = {
        id: item.messageId,
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
        ...(item.type === "user_message" && item.attachments.length > 0
          ? {
              attachments: item.attachments.map((attachment) => {
                const previewUrl = input.attachmentUrlById?.get(attachment.id);
                return previewUrl ? { ...attachment, previewUrl } : attachment;
              }),
            }
          : {}),
        runId: item.runId,
        streaming: item.type === "assistant_message" && item.streaming,
        ...(item.type === "user_message"
          ? { createdBy: item.createdBy, creationSource: item.creationSource }
          : {}),
        createdAt,
        updatedAt: DateTime.formatIso(item.updatedAt),
        ...(item.type === "user_message" ? { inputIntent: item.inputIntent } : {}),
      };
      committedMessageIds.add(message.id);
      entries.push({
        id: message.id,
        kind: "message",
        createdAt,
        message,
        projectedItem: row,
        ...attemptMetadata,
      });
      continue;
    }

    if (item.type === "proposed_plan") {
      const proposedPlan = {
        id: item.planId,
        runId: item.runId,
        planMarkdown: item.markdown,
        status: "active" as const,
        implementedAt: null,
        implementationThreadId: null,
        createdAt,
        updatedAt: DateTime.formatIso(item.updatedAt),
      };
      entries.push({
        id: item.id,
        kind: "proposed-plan",
        createdAt,
        proposedPlan,
        ...attemptMetadata,
      });
      continue;
    }

    if (STANDALONE_V2_ITEM_TYPES.has(item.type)) {
      entries.push({
        id: item.id,
        kind: "event",
        createdAt,
        projectedItem: row,
        ...attemptMetadata,
      });
      continue;
    }

    entries.push({
      id: item.id,
      kind: "work",
      createdAt,
      entry: projectedWorkEntry(row),
      ...attemptMetadata,
    });
  }

  for (const message of input.optimisticMessages) {
    if (!committedMessageIds.has(message.id)) {
      entries.push({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      });
    }
  }

  return entries;
}

export function inferCheckpointTurnCountByRunId(
  summaries: ReadonlyArray<ThreadCheckpointSummary>,
): Record<string, number> {
  return Object.fromEntries(
    summaries.flatMap((summary) =>
      summary.runId === null ? [] : [[summary.runId, summary.checkpointTurnCount] as const],
    ),
  );
}

export function deriveRevertTurnCountByUserMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
}): Map<ChatMessage["id"], number> {
  const readyCheckpointByRunId = new Map<RunId, ThreadCheckpointSummary>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyCheckpointByRunId.set(checkpoint.runId, checkpoint);
    }
  }
  const byUserMessageId = new Map<ChatMessage["id"], number>();
  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message" || entry.message.role !== "user") continue;
    if (entry.message.inputIntent !== "turn_start" && entry.message.inputIntent !== "queued_turn") {
      continue;
    }
    if (entry.message.runId === null) continue;
    const checkpoint = readyCheckpointByRunId.get(entry.message.runId);
    if (checkpoint === undefined) continue;
    byUserMessageId.set(entry.message.id, Math.max(0, checkpoint.checkpointTurnCount - 1));
  }
  return byUserMessageId;
}

export function derivePhase(runtime: ThreadRuntimeSummary | null): SessionPhase {
  if (runtime === null) return "disconnected";
  if (
    runtime.status === "preparing" ||
    runtime.status === "starting" ||
    runtime.status === "queued"
  )
    return "connecting";
  if (runtime.status === "running" || runtime.status === "waiting") return "running";
  return "ready";
}

export type { TurnDiffSummary };
