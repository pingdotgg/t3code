import type { WorktreeSetupSnapshot } from "@t3tools/contracts";

/** The server restarts `sequence` for a later attempt, so a later `startedAt` wins first. */
export function compareWorktreeSetupSnapshots(
  a: WorktreeSetupSnapshot,
  b: WorktreeSetupSnapshot,
): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.sequence - b.sequence;
}

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  turnStarted: boolean;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live &&
    (!input.recorded || compareWorktreeSetupSnapshots(input.live, input.recorded) >= 0)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent) return null;
  if (snapshot.phase !== "done") return snapshot;
  if (!input.turnStarted) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}
