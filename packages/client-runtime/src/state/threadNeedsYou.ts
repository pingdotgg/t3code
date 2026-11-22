import type { EnvironmentThreadShell } from "./models.ts";
import { isShownUnderParent } from "./threadShell.ts";

export type NeedsYouReason = "approval" | "input" | "request";

const NEEDS_YOU_PRIORITY: Record<NeedsYouReason, number> = {
  approval: 0,
  input: 1,
  request: 2,
};

type NeedsYouInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
>;

/** What the thread waits on the user for, or null. The agent's own requests come before a guest's. */
export function resolveThreadNeedsYouReason(thread: NeedsYouInput): NeedsYouReason | null {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "request";
  return null;
}

/**
 * Threads blocked on the user across every project and environment, ignoring list filters,
 * snooze and settle: a hidden approval would stall its agent. Delegated children are left out
 * because their parent already carries their request.
 */
export function selectNeedsYouThreads<
  T extends NeedsYouInput &
    Pick<EnvironmentThreadShell, "archivedAt" | "environmentId" | "id" | "lineage">,
>(
  threads: readonly T[],
  delegatedUnderParent: ReadonlySet<string>,
): Array<{ readonly thread: T; readonly reason: NeedsYouReason }> {
  const entries: Array<{ readonly thread: T; readonly reason: NeedsYouReason }> = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (
      isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        delegatedUnderParent,
      )
    ) {
      continue;
    }
    const reason = resolveThreadNeedsYouReason(thread);
    if (reason !== null) entries.push({ thread, reason });
  }
  return entries.sort(
    (left, right) => NEEDS_YOU_PRIORITY[left.reason] - NEEDS_YOU_PRIORITY[right.reason],
  );
}
