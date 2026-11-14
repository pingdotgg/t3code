import type { ThreadStructureRuntime, ThreadStructureVisibleTurnItem } from "../state/models.ts";
import { turnItemIsWorkspacePreparation } from "../state/turnItemPresentation.ts";
import {
  isAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";
import * as DateTime from "effect/DateTime";

type TurnItem = ThreadStructureVisibleTurnItem["item"];
type ItemOf<T extends TurnItem["type"]> = Extract<TurnItem, { readonly type: T }>;
type Base = "id" | "runId" | "status" | "title";
// Streamed assistant text carries no updatedAt in the quiet projection.
type Timed = Base | "updatedAt";

/** Only the fields the panel reads, so a real turn item fits and tests stay small. */
export type ActivityItem =
  | Pick<ItemOf<"command_execution">, Timed | "type" | "input">
  | Pick<ItemOf<"file_change">, Timed | "type" | "fileName" | "additions" | "deletions" | "changes">
  | Pick<ItemOf<"file_search">, Timed | "type" | "pattern">
  | Pick<ItemOf<"web_search">, Timed | "type">
  | Pick<ItemOf<"dynamic_tool">, Timed | "type">
  | Pick<ItemOf<"subagent">, Timed | "type">
  | Pick<ItemOf<"approval_request">, Timed | "type">
  | Pick<ItemOf<"user_input_request">, Timed | "type">
  | Pick<ItemOf<"todo_list">, Timed | "type" | "steps">
  | Pick<ItemOf<"assistant_message">, Base | "type">
  | Pick<ItemOf<"error">, Timed | "type" | "failure" | "retry">;

/** Items that still mark which run is latest, but are not shown as activity. */
type OtherItem = Pick<Exclude<TurnItem, { readonly type: ActivityItem["type"] }>, "type" | "runId">;

const ACTIVITY_ITEM_TYPES: ReadonlySet<string> = new Set<ActivityItem["type"]>([
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
  "error",
]);

// Setup the app does before the agent starts is not the agent's progress.
const isActivityItem = (item: ActivityItem | OtherItem): item is ActivityItem =>
  ACTIVITY_ITEM_TYPES.has(item.type) && !turnItemIsWorkspacePreparation(item);

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
  readonly outcome: "finished" | "failed" | "incomplete" | "stopped" | null;
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
  const trimmedRoot = workspaceRoot?.replace(/[\\/]+$/, "");
  if (!trimmedRoot) return text;
  const prefix = `${trimmedRoot}/`;
  let result = "";
  let from = 0;
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, from)) {
    result += text.slice(from, at);
    from = at + prefix.length;
    // `/var/app/x` contains `/app/` but is not inside the workspace `/app`.
    if (/[\w./~-]/.test(text[at - 1] ?? "")) result += prefix;
  }
  return result + text.slice(from);
}

// Some providers title every tool call "Tool", which says nothing.
function meaningfulTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  return trimmed && trimmed.toLowerCase() !== "tool" ? trimmed : null;
}

function labelFor(item: ActivityItem, workspaceRoot: string | null): string | null {
  // Labels we write ourselves read in the present tense while the step is still going.
  const live = item.status === "running" || item.status === "pending";
  switch (item.type) {
    case "command_execution":
      return (
        trimLabel(withoutRoot(meaningfulTitle(item.title) ?? item.input, workspaceRoot)) ||
        (live ? "Running a command" : "Ran a command")
      );
    case "file_change":
      return `${live ? "Editing" : "Edited"} ${basename(item.fileName)}`;
    case "file_search":
      return withoutRoot(
        item.title ??
          (item.pattern
            ? `${live ? "Searching" : "Searched"} ${trimLabel(item.pattern)}`
            : live
              ? "Searching files"
              : "Searched files"),
        workspaceRoot,
      );
    case "web_search":
      return item.title ?? (live ? "Searching the web" : "Searched the web");
    case "dynamic_tool": {
      const title = meaningfulTitle(item.title);
      return title ? withoutRoot(title, workspaceRoot) : live ? "Using a tool" : "Used a tool";
    }
    case "subagent":
      return item.title ?? (live ? "Running a subagent" : "Ran a subagent");
    case "approval_request":
      return "Waiting for your approval";
    case "user_input_request":
      return "Waiting for your answer";
    // An error the provider is retrying is not the end of the run.
    case "error":
      return item.retry === undefined ? trimLabel(item.failure.message) || "Run failed" : null;
    case "todo_list":
    case "assistant_message":
      return null;
  }
}

function addCount(current: number | null, next: number | undefined): number | null {
  return next === undefined ? current : (current ?? 0) + next;
}

function workspacePath(fileName: string, workspaceRoot: string | null) {
  if (!isAbsolutePath(fileName)) {
    // `../x` is not in the workspace, and the file service rejects it.
    const inside =
      workspaceRoot === null ||
      workspaceRelativeFilePath(
        resolveWorkspaceFilePath(fileName, workspaceRoot),
        workspaceRoot,
      ) !== null;
    return { path: fileName, openable: inside };
  }
  const relative = workspaceRelativeFilePath(fileName, workspaceRoot);
  return relative === null
    ? { path: fileName, openable: false }
    : { path: relative, openable: true };
}

/**
 * What the agent is doing and has done in the latest run, from items every provider produces.
 * Pass every item, not only the ones shown: a new run is latest even before it does any work.
 */
export function deriveActivitySummary(
  items: ReadonlyArray<ActivityItem | OtherItem>,
  workspaceRoot: string | null,
  /** The run has not ended, even when no item is running: the agent may be thinking or replying. */
  runActive: boolean,
  /** The run in progress, which can exist before it has any item. */
  activeRunId: ActivityItem["runId"] = null,
  runStatus: ThreadStructureRuntime["status"] | "pending" | null = null,
): ActivitySummary {
  const latestRunId = activeRunId ?? items.findLast((item) => item.runId !== null)?.runId ?? null;
  const runItems = items.filter((item) => item.runId === latestRunId).filter(isActivityItem);

  let runningLabel: string | null = null;
  let waitingLabel: string | null = null;
  const done: ActivityStep[] = [];
  const filesByPath = new Map<string, Omit<ActivityFile, "path">>();
  let latestTodo: Extract<ActivityItem, { type: "todo_list" }> | null = null;
  let lastActivityAt: string | null = null;

  for (const item of runItems) {
    if (item.type === "todo_list") latestTodo = item;
    if ("updatedAt" in item) {
      const updatedAt = DateTime.formatIso(item.updatedAt);
      if (lastActivityAt === null || updatedAt > lastActivityAt) lastActivityAt = updatedAt;
    }
    // An edit still waiting for approval, or one that failed, has not changed the file.
    if (item.type === "file_change" && (item.status === "completed" || item.status === "running")) {
      const paths = item.changes?.map((change) => change.path) ?? [item.fileName];
      for (const fileName of paths) {
        const { path, openable } = workspacePath(fileName, workspaceRoot);
        const current = filesByPath.get(path) ?? { openable, additions: null, deletions: null };
        // The item's counts cover all its files, so they cannot be pinned on one of several.
        const counted = paths.length === 1;
        filesByPath.set(path, {
          openable,
          additions: addCount(current.additions, counted ? item.additions : undefined),
          deletions: addCount(current.deletions, counted ? item.deletions : undefined),
        });
      }
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

  const stopped =
    runStatus === "interrupted" || runStatus === "cancelled" || runStatus === "rolled_back";
  // Retained background commands stay visible, but cannot revive a stopped run.
  const phase: ActivitySummary["phase"] =
    stopped || runStatus === "failed"
      ? "idle"
      : waitingLabel !== null
        ? "waiting"
        : runningLabel !== null || runActive
          ? "running"
          : "idle";

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
      : failedCount > 0 || runStatus === "failed"
        ? "failed"
        : plan !== null && plan.completed < plan.steps.length
          ? "incomplete"
          : stopped
            ? "stopped"
            : "finished";

  return {
    phase,
    outcome,
    now: phase === "idle" ? null : (waitingLabel ?? runningLabel),
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
