import { Atom } from "effect/reactivity";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";

export const forkWorkspacePreparingAtom = Atom.family((_threadKey: string) =>
  Atom.make(false).pipe(Atom.keepAlive),
);

export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  turnStarted: boolean;
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
  if (!input.turnStarted && snapshot.stages.some((stage) => stage.id === "agent")) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}

export function worktreeSetupReadyForMessages(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.readyForMessages === true || worktreeSetupAgentStarted(snapshot);
}
