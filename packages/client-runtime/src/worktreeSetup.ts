import {
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeWorktreeSetupSnapshot = Schema.decodeUnknownOption(WorktreeSetupSnapshot);

/**
 * The worktree setup the server recorded on the thread, if any: running once
 * the bootstrap created the thread, then the settled outcome. It is what a
 * reload or a second client renders, and what tells them to attach the live
 * stream while it still says running.
 */
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

/**
 * Which setup snapshot the timeline shows, if any. The live stream wins while
 * it has a newer sequence; the recorded activity covers everything else. A
 * running setup always shows. The setup belongs to the thread's first turn:
 * once the user has sent a follow-up it is history and nothing about it is
 * shown again, whatever its outcome. Within that first turn, a clean finish
 * leaves no trace once the turn is live (the setup is a means to the reply,
 * not part of the conversation), while a failed script, a failed setup, or a
 * cancelled one stays so the outcome, exit code, and terminal are reachable.
 * Before the turn is live everything stays so nothing collapses in the
 * handoff gap. Visibility never depends on whether a turn happens to be
 * running, which would make the row come and go.
 */
export function resolveVisibleWorktreeSetup(input: {
  live: WorktreeSetupSnapshot | null;
  recorded: WorktreeSetupSnapshot | null;
  turnStarted: boolean;
  /** The user sent a message after the one that created the worktree. */
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
