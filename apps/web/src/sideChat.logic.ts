import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadId } from "@t3tools/contracts";

/**
 * A side chat is an ordinary thread whose `sideChat` flag moves it out of the
 * sidebar. The parent it hangs from is `lineage.parentThreadId`, whether it
 * was forked (shared history) or only linked (none).
 */
type SideChatShell = Pick<
  EnvironmentThreadShell,
  | "id"
  | "sideChat"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "createdAt"
  | "latestRun"
  | "itemCount"
>;

/** The parent's side chats, newest first. Archived and deleted ones are gone for good. */
export function sideChatsOf<T extends SideChatShell>(
  threads: ReadonlyArray<T>,
  parentThreadId: ThreadId,
): T[] {
  return threads
    .filter(
      (thread) =>
        thread.sideChat &&
        thread.lineage.parentThreadId === parentThreadId &&
        thread.archivedAt === null &&
        thread.deletedAt === null,
    )
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

const SETTLED_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);

/** A side chat is "previous" once nothing is running in it, like a finished subagent. */
export function isPreviousSideChat(thread: Pick<SideChatShell, "latestRun">): boolean {
  return thread.latestRun === null || SETTLED_RUN_STATUSES.has(thread.latestRun.status);
}

/** Shapes a side chat's latest run for `AgentElapsed`, the timer subagent rows use. */
export function sideChatActivity(
  thread: Pick<SideChatShell, "latestRun">,
): Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt"> {
  const run = thread.latestRun;
  if (run === null) return { status: "idle", startedAt: null, completedAt: null };
  const status: RuntimeSubagent["status"] = SETTLED_RUN_STATUSES.has(run.status)
    ? run.status === "completed"
      ? "completed"
      : run.status === "failed"
        ? "failed"
        : "interrupted"
    : run.status === "waiting"
      ? "waiting"
      : "running";
  return {
    status,
    startedAt: run.startedAt ?? run.requestedAt,
    completedAt: run.completedAt,
  };
}

/** Closing a side chat that never received a message throws it away. */
export function isEmptySideChat(thread: Pick<SideChatShell, "latestRun" | "itemCount">): boolean {
  return thread.latestRun === null && thread.itemCount === 0;
}

/** Blockquote a selection so it reads as a citation in the side chat's first message. */
export function quoteForSideChat(text: string): string {
  return `${text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n")}\n\n`;
}

export interface ParsedSideCommand {
  readonly command: "side" | "btw";
  readonly question: string;
}

/**
 * `/side` and its alias `/btw`. A question after the command is sent
 * immediately; the bare command reopens the latest side chat.
 */
export function parseSideCommand(prompt: string): ParsedSideCommand | null {
  const match = /^\/(side|btw)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (match === null) return null;
  return { command: match[1] as ParsedSideCommand["command"], question: (match[2] ?? "").trim() };
}
