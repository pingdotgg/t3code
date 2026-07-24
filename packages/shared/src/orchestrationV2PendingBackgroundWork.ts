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

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

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
  return TERMINAL_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title;
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName;
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
 * Grok persistent monitors (`dynamic_tool` input with `persistent: true`).
 * Does not consult subagent entities (those double-count turn items).
 */
export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();

  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);

  for (const providerThread of providerThreads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      byTaskId.set(task.taskId, {
        taskId: task.taskId,
        ...(task.description === undefined ? {} : { description: task.description }),
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

    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    const description = descriptionFromTurnItem(item);
    byTaskId.set(taskId, {
      taskId,
      ...(description === undefined ? {} : { description }),
      ...(item.type === "subagent"
        ? { taskType: "subagent" }
        : item.type === "command_execution"
          ? { taskType: "command_execution" }
          : item.type === "dynamic_tool"
            ? { taskType: "dynamic_tool" }
            : {}),
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
