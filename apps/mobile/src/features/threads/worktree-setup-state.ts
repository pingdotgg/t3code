import type { ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import { compareWorktreeSetupSnapshots } from "@t3tools/client-runtime/worktree-setup";

/** A subscription can close or replay an older value during the setup handoff. */
export function resolveWorktreeSetupSnapshot(
  threadId: ThreadId | null,
  latest: WorktreeSetupSnapshot | null | undefined,
  held: WorktreeSetupSnapshot | null,
): WorktreeSetupSnapshot | null {
  const current = latest?.threadId === threadId ? latest : null;
  const previous = held?.threadId === threadId ? held : null;
  return current && (!previous || compareWorktreeSetupSnapshots(current, previous) >= 0)
    ? current
    : previous;
}
