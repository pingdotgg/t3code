import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import { isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";

type TurnItem = ThreadStructureVisibleTurnItem["item"];
type ItemOf<T extends TurnItem["type"]> = Extract<TurnItem, { readonly type: T }>;
type Base = "id" | "runId" | "status" | "title";
// Streamed assistant text carries no updatedAt in the quiet projection.
type Timed = Base | "updatedAt";

/** Only the fields the panel reads, so a real turn item fits and tests stay small. */
export type ActivityItem =
  | Pick<ItemOf<"command_execution">, Timed | "type" | "input">
  | Pick<ItemOf<"file_change">, Timed | "type" | "fileName" | "additions" | "deletions">
  | Pick<ItemOf<"file_search">, Timed | "type" | "pattern">
  | Pick<ItemOf<"web_search">, Timed | "type">
  | Pick<ItemOf<"dynamic_tool">, Timed | "type">
  | Pick<ItemOf<"subagent">, Timed | "type">
  | Pick<ItemOf<"approval_request">, Timed | "type">
  | Pick<ItemOf<"user_input_request">, Timed | "type">
  | Pick<ItemOf<"todo_list">, Timed | "type" | "steps">
  | Pick<ItemOf<"assistant_message">, Base | "type">;

const ACTIVITY_ITEM_TYPES: ReadonlySet<TurnItem["type"]> = new Set<ActivityItem["type"]>([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "approval_request",
  "user_input_request",
  "todo_list",
  "assistant_message",
]);

export function isActivityItem(
  item: TurnItem,
): item is Extract<TurnItem, { readonly type: ActivityItem["type"] }> {
  // Setup the app does before the agent starts is not the agent's progress.
  return ACTIVITY_ITEM_TYPES.has(item.type) && !turnItemIsWorkspacePreparation(item);
}

export interface ActivityStep {
  readonly id: string;
  readonly label: string;
  readonly failed: boolean;
}

export interface ActivityFile {
  /** Workspace-relative when the file is inside the workspace. */
  readonly path: string;
  /** False for files outside the workspace, which the file tab cannot open. */
  readonly openable: boolean;
  /** Null when the provider did not report line counts. */
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface ActivityFolder {
  readonly folder: string;
  readonly files: ReadonlyArray<ActivityFile>;
}

export interface ActivityPlan {
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly status: "pending" | "running" | "completed";
  }>;
  readonly completed: number;
}

export interface ActivitySummary {
  readonly phase: "running" | "waiting" | "idle";
  /** How an idle run ended; null while it is still running or waiting. */
  readonly outcome: "finished" | "failed" | "incomplete" | null;
  readonly now: string | null;
  readonly done: ReadonlyArray<ActivityStep>;
  readonly failedCount: number;
  readonly touched: ReadonlyArray<ActivityFolder>;
  /** Sums over touched files; a side is null when no file reported it. */
  readonly touchedTotals: {
    readonly files: number;
    readonly additions: number | null;
    readonly deletions: number | null;
  };
  readonly plan: ActivityPlan | null;
  /** When the latest run last changed, as an ISO timestamp. */
  readonly lastActivityAt: string | null;
}

const MAX_LABEL_LENGTH = 80;

function trimLabel(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > MAX_LABEL_LENGTH
    ? `${firstLine.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : firstLine;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}

function withoutRoot(text: string, workspaceRoot: string | null): string {
  return workspaceRoot === null
    ? text
    : text.replaceAll(`${workspaceRoot.replace(/[\\/]+$/, "")}/`, "");
}

function labelFor(item: ActivityItem, workspaceRoot: string | null): string | null {
  switch (item.type) {
    case "command_execution":
      return trimLabel(withoutRoot(item.title ?? item.input, workspaceRoot)) || "Ran a command";
    case "file_change":
      return `Edited ${basename(item.fileName)}`;
    case "file_search":
      return withoutRoot(
        item.title ?? (item.pattern ? `Searched ${trimLabel(item.pattern)}` : "Searched files"),
        workspaceRoot,
      );
    case "web_search":
      return item.title ?? "Searched the web";
    case "dynamic_tool": {
      // Some providers title every tool call "Tool", which says nothing.
      const title = item.title?.trim();
      return title && title.toLowerCase() !== "tool"
        ? withoutRoot(title, workspaceRoot)
        : "Used a tool";
    }
    case "subagent":
      return item.title ?? "Ran a subagent";
    case "approval_request":
      return "Waiting for your approval";
    case "user_input_request":
      return "Waiting for your answer";
    case "todo_list":
    case "assistant_message":
      return null;
  }
}

function addCount(current: number | null, next: number | undefined): number | null {
  return next === undefined ? current : (current ?? 0) + next;
}

function workspacePath(fileName: string, workspaceRoot: string | null) {
  if (!isAbsolutePath(fileName)) return { path: fileName, openable: true };
  const relative = workspaceRelativeFilePath(fileName, workspaceRoot);
  return relative === null
    ? { path: fileName, openable: false }
    : { path: relative, openable: true };
}

/** What the agent is doing and has done in the latest run, from items every provider produces. */
export function deriveActivitySummary(
  items: ReadonlyArray<ActivityItem>,
  workspaceRoot: string | null,
): ActivitySummary {
  const latestRunId = items.findLast((item) => item.runId !== null)?.runId ?? null;
  const runItems = latestRunId === null ? [] : items.filter((item) => item.runId === latestRunId);

  let runningLabel: string | null = null;
  let waitingLabel: string | null = null;
  const done: ActivityStep[] = [];
  const filesByPath = new Map<string, Omit<ActivityFile, "path">>();
  let latestTodo: Extract<ActivityItem, { type: "todo_list" }> | null = null;
  let lastActivityAt: string | null = null;

  for (const item of runItems) {
    if (item.type === "todo_list") latestTodo = item;
    if ("updatedAt" in item) lastActivityAt = DateTime.formatIso(item.updatedAt);
    // An edit still waiting for approval, or one that failed, has not changed the file.
    if (item.type === "file_change" && (item.status === "completed" || item.status === "running")) {
      const { path, openable } = workspacePath(item.fileName, workspaceRoot);
      const current = filesByPath.get(path) ?? { openable, additions: null, deletions: null };
      filesByPath.set(path, {
        openable,
        additions: addCount(current.additions, item.additions),
        deletions: addCount(current.deletions, item.deletions),
      });
    }

    const label = labelFor(item, workspaceRoot);
    if (label === null) continue;
    if (item.status === "running" || item.status === "pending") {
      runningLabel = label;
    } else if (item.status === "waiting") {
      waitingLabel = label;
    } else if (
      (item.status === "completed" || item.status === "failed") &&
      // Answered requests only ever drive the status line; they are not work the agent did.
      item.type !== "approval_request" &&
      item.type !== "user_input_request"
    ) {
      done.push({ id: item.id, label, failed: item.status === "failed" });
    }
  }

  const folders = new Map<string, ActivityFile[]>();
  for (const [path, counts] of filesByPath) {
    const folder = dirname(path);
    const files = folders.get(folder) ?? [];
    files.push({ path, ...counts });
    folders.set(folder, files);
  }

  const touched = [...folders].map(([folder, files]) => ({ folder, files }));
  const touchedFiles = touched.flatMap((folder) => folder.files);
  const sum = (pick: (file: ActivityFile) => number | null): number | null =>
    touchedFiles.reduce<number | null>(
      (total, file) => addCount(total, pick(file) ?? undefined),
      null,
    );

  // What needs the user wins over what is running.
  const phase: ActivitySummary["phase"] =
    waitingLabel !== null ? "waiting" : runningLabel !== null ? "running" : "idle";

  const plan =
    latestTodo === null
      ? null
      : {
          steps: latestTodo.steps,
          completed: latestTodo.steps.filter((step) => step.status === "completed").length,
        };
  const failedCount = done.filter((step) => step.failed).length;
  const outcome: ActivitySummary["outcome"] =
    phase !== "idle"
      ? null
      : failedCount > 0
        ? "failed"
        : plan !== null && plan.completed < plan.steps.length
          ? "incomplete"
          : "finished";

  return {
    phase,
    outcome,
    now: waitingLabel ?? runningLabel,
    done,
    failedCount,
    touched,
    touchedTotals: {
      files: touchedFiles.length,
      additions: sum((file) => file.additions),
      deletions: sum((file) => file.deletions),
    },
    lastActivityAt,
    plan,
  };
}
