import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type { KeybindingCommand, ThreadId } from "@t3tools/contracts";

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
  | "runtime"
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

const SETTLED_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

/**
 * A side chat is "previous" once nothing is running in it, like a finished
 * subagent. The live runtime decides first: a cancelled queued follow-up is the
 * latest run while an older one may still be working.
 */
export function isPreviousSideChat(thread: Pick<SideChatShell, "latestRun" | "runtime">): boolean {
  if (threadRuntimeIsActive(thread.runtime)) return false;
  return thread.latestRun === null || SETTLED_RUN_STATUSES.has(thread.latestRun.status);
}

/** Shapes a side chat's current or latest run for `AgentElapsed`, the timer subagent rows use. */
export function sideChatActivity(
  thread: Pick<SideChatShell, "latestRun" | "runtime">,
): Pick<RuntimeSubagent, "status" | "startedAt" | "completedAt"> {
  const run = thread.latestRun;
  const runtime = thread.runtime;
  if (runtime !== null && threadRuntimeIsActive(runtime)) {
    return {
      status: runtime.status === "waiting" ? "waiting" : "running",
      startedAt:
        runtime.activityStartedAt ??
        (run !== null && !SETTLED_RUN_STATUSES.has(run.status)
          ? (run.startedAt ?? run.requestedAt)
          : null),
      completedAt: null,
    };
  }
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

/** Panel layout and Find shortcuts the host thread still handles while a side chat has focus. */
const SIDE_CHAT_PASSTHROUGH_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "chat.find",
  "rightPanel.close",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "threadPanel.toggle",
]);
/** Shortcuts a side chat handles itself: its own run, composer, toolbar, and queue. */
export const SIDE_CHAT_OWN_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "thread.stop",
  "modelPicker.toggle",
  "composer.effort",
  "composer.increaseEffort",
  "composer.decreaseEffort",
  "composer.mode",
  "composer.host",
  "composer.workspace",
  "composer.branch",
  "composer.previousWorktree",
  "thread.steerQueuedMessage",
  "thread.editQueuedMessage",
]);

/**
 * Whether one chat view takes a window shortcut. A host thread and its embedded
 * side chat both listen, so each claims only its own keys. `targetChat` is the
 * embedded chat the event came from, or null outside any; `resolveCommand` is
 * only called when the answer depends on the command.
 */
export function chatClaimsShortcut(input: {
  readonly embedded: boolean;
  readonly threadId: string;
  /** Embedded only: this side chat has its parent's composer. */
  readonly focused: boolean;
  /** Host only: the side chat that has this thread's composer. */
  readonly focusedSideChatId: string | null;
  readonly targetChat: string | null;
  readonly resolveCommand: () => KeybindingCommand | null;
}): boolean {
  const { targetChat } = input;
  // A side chat answers keys pressed inside it, and keys pressed outside any
  // chat while it has its parent's composer.
  if (input.embedded)
    return targetChat === input.threadId || (targetChat === null && input.focused);
  if (targetChat === null && input.focusedSideChatId === null) return true;
  const command = input.resolveCommand();
  // Outside any chat, composer shortcuts go to the side chat that has the composer.
  if (targetChat === null) return command === null || !SIDE_CHAT_OWN_COMMANDS.has(command);
  // With focus in a side chat, only panel layout and Find act on the host.
  return command !== null && SIDE_CHAT_PASSTHROUGH_COMMANDS.has(command);
}
