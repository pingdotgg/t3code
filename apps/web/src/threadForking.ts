import type { SidebarThreadSummary, Thread, ThreadSession } from "./types";

function sessionIsBusy(session: ThreadSession | null | undefined): boolean {
  return (
    session?.orchestrationStatus === "starting" ||
    session?.orchestrationStatus === "running" ||
    session?.activeTurnId !== undefined
  );
}

export function threadHasStarted(
  thread: Pick<Thread, "latestTurn" | "messages" | "session"> | null | undefined,
): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export function buildForkedThreadTitle(title: string): string {
  return `${title} (fork)`;
}

export function canForkThread(
  thread: Pick<Thread, "latestTurn" | "messages" | "session" | "turnQueue">,
): boolean {
  return (
    threadHasStarted(thread) &&
    !sessionIsBusy(thread.session) &&
    thread.turnQueue.items.length === 0
  );
}

export function canForkSidebarThread(
  thread: Pick<
    SidebarThreadSummary,
    "latestTurn" | "latestUserMessageAt" | "session" | "queuedTurnCount"
  >,
): boolean {
  return (
    (thread.latestTurn !== null ||
      thread.latestUserMessageAt !== null ||
      thread.session !== null) &&
    !sessionIsBusy(thread.session) &&
    thread.queuedTurnCount === 0
  );
}
