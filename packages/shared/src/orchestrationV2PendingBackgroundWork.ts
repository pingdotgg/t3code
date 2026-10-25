import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { resolveT3McpToolId } from "./t3McpToolPresentation.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

// Plans and text streams can stay open across tool calls without executing work.
const EXECUTION_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  ...BACKGROUND_TURN_ITEM_TYPES,
  "file_change",
  "file_search",
  "web_search",
  "compaction",
]);

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

// waiting is completed work awaiting checkpoints; exclude rolled_back entirely because provider threads are not run-tied.
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

export function deriveBlockedOnThreadWait(input: {
  readonly activeRun: Pick<OrchestrationV2Run, "id" | "status"> | null;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): boolean {
  if (input.activeRun?.status !== "running") return false;
  let hasWait = false;
  for (const item of input.turnItems) {
    if (
      item.runId !== input.activeRun.id ||
      !EXECUTION_TURN_ITEM_TYPES.has(item.type) ||
      (item.status !== "running" && item.status !== "waiting") ||
      // App-owned rows track the child, including the child a blocking delegate is waiting for.
      (item.type === "subagent" && item.origin === "app_owned")
    ) {
      continue;
    }
    if (item.type !== "dynamic_tool") return false;
    const tool = resolveT3McpToolId(item.toolName);
    if (
      tool !== "t3_thread_wait" &&
      !(
        tool === "delegate_task" &&
        Predicate.isObject(item.input) &&
        Reflect.get(item.input, "mode") === "wait"
      )
    ) {
      return false;
    }
    hasWait = true;
  }
  return hasWait;
}

export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind" | "awaited">>,
): boolean {
  return tasks.some(
    (task) => task.awaited === true || backgroundWorkKindHoldsCompletion(task.kind),
  );
}

// Commands and monitors are as often a dev server or its watchdog as a wait, so they hold
// only when the agent marks them awaited.
function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
    case "monitor":
      return false;
    case "subagent":
    case "background_task":
      return true;
  }
}

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

type PendingBackgroundWorkPullRequest = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "source" | "watch"
>;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
> & { readonly providerInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"] };

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** Shell readers join the owner, even when its provider thread belongs to a child app thread. */
  readonly owningProviderInstanceId?: OrchestrationV2ProviderThread["providerInstanceId"];
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly monitor?: boolean | undefined;
  readonly prompt?: string | undefined;
  readonly childThreadId?: ThreadId | null;
};

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

function pendingTaskFromTurnItem(
  taskId: string,
  item: PendingBackgroundWorkTurnItem,
): PendingBackgroundWorkTask {
  const description = descriptionFromTurnItem(item);
  const named = { taskId, ...(description === undefined ? {} : { description }) };
  switch (item.type) {
    case "subagent":
      return {
        ...named,
        kind: "subagent",
        ...(item.owningProviderInstanceId === undefined
          ? {}
          : { providerInstanceId: item.owningProviderInstanceId }),
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
      };
    case "command_execution":
      return { ...named, kind: item.monitor === true ? "monitor" : "command" };
    default:
      return { ...named, kind: "background_task" };
  }
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/** Items Stop ends, without the pending list's settled-run gate. */
export function pendingBackgroundTurnItems<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<Item> {
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  return input.turnItems.filter(
    (item) =>
      BACKGROUND_TURN_ITEM_TYPES.has(item.type) &&
      isOrchestrationV2WorkActive(item.status) &&
      !(item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) &&
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /** Excludes rolled-back runs; optional only when the caller already filtered them, as SQL shell reads do. */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
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
  if (input.latestRun == null) {
    return pullRequestWatchTasks(input.pullRequests);
  }
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
      const { description: rawDescription, ...named } = task;
      const description = rawDescription?.trim();
      byTaskId.set(task.taskId, {
        ...named,
        ...(task.kind === "subagent"
          ? { providerInstanceId: providerThread.providerInstanceId }
          : {}),
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    }
  }

  for (const item of pendingBackgroundTurnItems(input)) {
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    byTaskId.set(taskId, pendingTaskFromTurnItem(taskId, item));
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

function pullRequestWatchTasks(
  pullRequests: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (pullRequests ?? []).flatMap((link) =>
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            // Links store their normalized identity, and this id only has to be unique within the
            // thread, so it reads those fields instead of parsing the URL.
            taskId: `pull-request-watch:${link.host.toLowerCase()}/${link.repository.toLowerCase()}#${link.number}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
            awaited: true as const,
          },
        ],
  );
}
