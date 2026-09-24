import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";

export type PullRequestPreviewThread = ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    | "id"
    | "environmentId"
    | "projectId"
    | "title"
    | "branch"
    | "archivedAt"
    | "settledOverride"
    | "linkedPullRequest"
    | "pullRequests"
    | "branchPullRequest"
  >;

export interface PullRequestPreviewCapabilities {
  readonly threadSettlement?: boolean | undefined;
  readonly threadSnooze?: boolean | undefined;
  readonly threadPullRequests?: boolean | undefined;
}

export interface PullRequestPreviewEntry {
  readonly thread: PullRequestPreviewThread;
  readonly reference: ThreadLinkedPullRequest;
  /** The current link when this row came from the multi-PR thread model. */
  readonly pullRequestLink: ThreadPullRequestLink | null;
  readonly snoozed: boolean;
}

function pullRequestIdentity(
  reference: ThreadLinkedPullRequest,
  pullRequestLink: ThreadPullRequestLink | null,
): string {
  return threadPullRequestKeyOf(
    pullRequestLink === null ? legacyThreadPullRequestKey(reference) : pullRequestLink,
  );
}

function linkedReference(
  link: ThreadPullRequestLink,
  projectId: ThreadLinkedPullRequest["projectId"],
): ThreadLinkedPullRequest {
  return {
    projectId,
    repository: link.repository,
    number: link.number,
    url: link.url,
  };
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
    const capabilities = capabilitiesByEnvironment.get(thread.environmentId);
    const isSnoozed = capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now });
    if (
      !isSnoozed &&
      capabilities?.threadSettlement === true &&
      thread.settledOverride === "settled"
    ) {
      continue;
    }
    const supportsModernLinks = capabilities?.threadPullRequests === true;
    const links = supportsModernLinks ? visibleThreadPullRequests(thread.pullRequests) : [];
    // A modern shell's visible links are the source of truth only when the
    // environment supports them. Older servers never emit the events, so a
    // cached shell reconnecting to one must fall back to legacy references
    // rather than keep showing a set nothing will ever update. Legacy fields
    // remain useful for cached/pre-migration shells, but adding them beside
    // the links can resurrect a stale projection or branch match as another
    // row for the same thread.
    const candidates: ReadonlyArray<{
      readonly reference: ThreadLinkedPullRequest;
      readonly pullRequestLink: ThreadPullRequestLink | null;
    }> =
      links.length > 0
        ? links.map((link) => ({
            reference: linkedReference(link, thread.projectId),
            pullRequestLink: link,
          }))
        : thread.linkedPullRequest
          ? [{ reference: thread.linkedPullRequest, pullRequestLink: null }]
          : thread.branchPullRequest
            ? [{ reference: thread.branchPullRequest, pullRequestLink: null }]
            : [];
    for (const { reference, pullRequestLink } of candidates) {
      // One row per pull request within an environment: the normalized host
      // identity already distinguishes repositories, so the thread's project
      // must not split the same request into duplicate rows. The surviving
      // entry keeps its representative thread for navigation.
      const key = [thread.environmentId, pullRequestIdentity(reference, pullRequestLink)].join(
        "\0",
      );
      const existing = byPullRequest.get(key);
      if (existing && (!existing.snoozed || isSnoozed)) continue;
      byPullRequest.set(key, { thread, reference, pullRequestLink, snoozed: isSnoozed });
    }
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
