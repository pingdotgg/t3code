import {
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeWorktreeSetupSnapshot = Schema.decodeUnknownOption(WorktreeSetupSnapshot);

export function findRecordedWorktreeSetup(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  threadId: ThreadId,
): WorktreeSetupSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== WORKTREE_SETUP_ACTIVITY_KIND) continue;
    const decoded = decodeWorktreeSetupSnapshot(activity.payload);
    if (Option.isSome(decoded) && decoded.value.threadId === threadId) return decoded.value;
  }
  return null;
}

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
  if (!input.turnStarted) return snapshot;
  return snapshot.stages.some((stage) => stage.status === "failed") ? snapshot : null;
}

export function worktreeSetupAgentStarted(snapshot: WorktreeSetupSnapshot): boolean {
  return snapshot.stages.some((stage) => stage.id === "agent" && stage.status === "done");
}
