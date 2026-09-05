import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

const TERMINAL_TURN_ITEM_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

/**
 * True terminal run statuses (includes `rolled_back`). Retained as the
 * canonical terminal set for this module; do not widen or reuse it as the
 * background-wait gate — that gate intentionally excludes `rolled_back`.
 */
const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

/**
 * Run statuses that allow a pending-background roster to surface.
 * Includes `waiting`: a successful turn persists as waiting until checkpoint
 * capture flips it to completed, and waiting is only set from completed.
 * Excludes `rolled_back`: the provider-thread roster is not run-tied, so a
 * rolled-back latest run must fail the gate entirely (not only item filter).
 * Built explicitly rather than spreading or deleting from TERMINAL_RUN_STATUSES.
 */
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

// Keep TERMINAL_RUN_STATUSES referenced so the true-terminal set stays defined
// next to the background-wait subset (rolled_back is terminal, not wait-settled).
void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
>;

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** When present and the run is rolled_back, the item is abandoned, not pending. */
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly prompt?: string | undefined;
};

function isTerminalTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return TERMINAL_TURN_ITEM_STATUSES.has(status);
}

function isLatestRunSettledForBackgroundWait(
  latestRun: PendingBackgroundWorkRun | null | undefined,
): boolean {
  if (latestRun === undefined || latestRun === null) {
    return false;
  }
  return SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName.trim();
    }
  }
  if (item.type === "subagent" && typeof item.prompt === "string") {
    const prompt = item.prompt.trim();
    return prompt.length > 0 ? prompt : undefined;
  }
  return undefined;
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/**
 * Derive one normalized pending-background-work list for post-settlement UI.
 *
 * Sources:
 * - Provider-thread roster (Claude SDK background tasks)
 * - Nonterminal command_execution / dynamic_tool / subagent turn items
 *
 * Gated on latest root run settlement. Dedupes by native task ID. Excludes
 * the roster while any interruptible foreground run remains active. Excludes
 * Grok persistent monitors (`dynamic_tool` input with `persistent: true`).
 * Excludes turn items whose run resolves to `rolled_back` (abandoned work);
 * items with a null or absent run id stay eligible (matches SQL shell path).
 * Does not consult subagent entities (those double-count turn items).
 */
export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /**
   * Run rows used to exclude items owned by rolled_back runs. Optional for
   * callers that already filtered (SQL shell path); in-memory callers should
   * pass projection runs so policy cannot drift.
   */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const hasActiveRun =
    input.hasActiveRun ??
    input.runs?.some(
      (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
    ) ??
    false;
  if (hasActiveRun) {
    return [];
  }
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );

  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);

  for (const providerThread of providerThreads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      const description = task.description?.trim();
      byTaskId.set(task.taskId, {
        taskId: task.taskId,
        ...(description === undefined || description.length === 0 ? {} : { description }),
        ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
      });
    }
  }

  for (const item of input.turnItems) {
    if (!BACKGROUND_TURN_ITEM_TYPES.has(item.type)) {
      continue;
    }
    if (isTerminalTurnItemStatus(item.status)) {
      continue;
    }
    if (item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) {
      continue;
    }
    // Null/absent run id stays eligible; only known rolled_back runs drop.
    const itemRunId = item.runId;
    if (itemRunId !== undefined && itemRunId !== null && rolledBackRunIds.has(String(itemRunId))) {
      continue;
    }

    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    const description = descriptionFromTurnItem(item);
    byTaskId.set(taskId, {
      taskId,
      ...(description === undefined ? {} : { description }),
      taskType: item.type,
    });
  }

  return Array.from(byTaskId.values());
}

export function formatPendingBackgroundWorkLabel(
  tasks: ReadonlyArray<PendingBackgroundWorkTask>,
): string | null {
  if (tasks.length === 0) {
    return null;
  }
  const firstDescription = tasks[0]?.description?.trim();
  if (tasks.length === 1) {
    return firstDescription && firstDescription.length > 0
      ? `Waiting on background task: ${firstDescription}`
      : "Waiting on a background task";
  }
  if (firstDescription && firstDescription.length > 0) {
    return `Waiting on ${tasks.length} background tasks: ${firstDescription}, …`;
  }
  return `Waiting on ${tasks.length} background tasks`;
}
