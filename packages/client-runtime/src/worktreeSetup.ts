import type { OrchestrationV2Run, WorktreeSetupSnapshot } from "@t3tools/contracts";

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "startedAt">>;
  followUpSent: boolean;
}): WorktreeSetupSnapshot | null {
  const snapshot =
    input.live && (!input.recorded || input.live.sequence >= input.recorded.sequence)
      ? input.live
      : input.recorded;
  if (!snapshot) return null;
  if (snapshot.phase === "running") return snapshot;
  if (input.followUpSent) return null;
  if (snapshot.phase !== "done") return snapshot;
  // A setup with no agent stage hands off to no run, so it waits on nothing once done.
  const waitsForAgent = snapshot.stages.some((stage) => stage.id === "agent");
  if (waitsForAgent && !input.runs.some((run) => run.startedAt !== null)) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}
