import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadLinkedPullRequest } from "@t3tools/contracts";

export type PullRequestPreviewThread = ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    | "id"
    | "environmentId"
    | "title"
    | "branch"
    | "archivedAt"
    | "settledOverride"
    | "linkedPullRequest"
    | "branchPullRequest"
  >;

export interface PullRequestPreviewCapabilities {
  readonly threadSettlement?: boolean | undefined;
  readonly threadSnooze?: boolean | undefined;
}

export interface PullRequestPreviewEntry {
  readonly thread: PullRequestPreviewThread;
  readonly reference: ThreadLinkedPullRequest;
  readonly snoozed: boolean;
}

/**
 * The pull requests the sidebar's active and snoozed shelves are tracking, one
 * row per pull request. Uses the sidebar's lifecycle classification (archived,
 * settled, snoozed) so a hidden thread does not resurface here; the project
 * scope filter is deliberately not applied, since the Pull Requests page reads
 * every project too. Active threads come first, then snoozed ones by wake time.
 * A pull request tracked by both an active and a snoozed thread counts as active.
 */
export function collectPullRequestPreviewEntries(
  threads: ReadonlyArray<PullRequestPreviewThread>,
  capabilitiesByEnvironment: ReadonlyMap<EnvironmentId, PullRequestPreviewCapabilities | undefined>,
  now: string,
): ReadonlyArray<PullRequestPreviewEntry> {
  const byPullRequest = new Map<string, PullRequestPreviewEntry>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
    if (!reference) continue;
    const capabilities = capabilitiesByEnvironment.get(thread.environmentId);
    const isSnoozed = capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now });
    if (
      !isSnoozed &&
      capabilities?.threadSettlement === true &&
      thread.settledOverride === "settled"
    ) {
      continue;
    }
    const key = [
      thread.environmentId,
      reference.projectId,
      reference.repository.toLowerCase(),
      reference.number,
    ].join("\0");
    const existing = byPullRequest.get(key);
    if (existing && (!existing.snoozed || isSnoozed)) continue;
    byPullRequest.set(key, { thread, reference, snoozed: isSnoozed });
  }
  const entries = [...byPullRequest.values()];
  const active = entries.filter((entry) => !entry.snoozed);
  const snoozed = entries.filter((entry) => entry.snoozed);
  snoozed.sort(
    (left, right) =>
      Date.parse(left.thread.snoozedUntil ?? "") - Date.parse(right.thread.snoozedUntil ?? ""),
  );
  return [...active, ...snoozed];
}
