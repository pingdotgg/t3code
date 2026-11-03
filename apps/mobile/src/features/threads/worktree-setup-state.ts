import type { ThreadId, WorktreeSetupRepository, WorktreeSetupSnapshot } from "@t3tools/contracts";

/** A subscription can close or replay an older value during the setup handoff. */
export function resolveWorktreeSetupSnapshot(
  threadId: ThreadId | null,
  latest: WorktreeSetupSnapshot | null | undefined,
  held: WorktreeSetupSnapshot | null,
): WorktreeSetupSnapshot | null {
  const current = latest?.threadId === threadId ? latest : null;
  const previous = held?.threadId === threadId ? held : null;
  return current && (!previous || current.sequence >= previous.sequence) ? current : previous;
}

const NO_REPOSITORIES: ReadonlyArray<WorktreeSetupRepository> = [];

/** The repos a failed task folder setup could not prepare; a retry can start without them. */
export function failedWorktreeSetupRepositories(
  snapshot: WorktreeSetupSnapshot | null | undefined,
): ReadonlyArray<WorktreeSetupRepository> {
  if (snapshot?.phase !== "failed") return NO_REPOSITORIES;
  const failed = snapshot.repositories.filter((repository) => repository.status === "failed");
  return failed.length === 0 ? NO_REPOSITORIES : failed;
}
