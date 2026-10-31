import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { threadDeepLink } from "@t3tools/shared/threadDeepLinks";

import { resolveThreadCurrentPullRequestLink } from "./threadPullRequests.ts";

export interface ThreadReferenceCopyTarget {
  readonly kind: "pull-request" | "thread";
  /** The plain text: a PR URL or a public thread deep link. */
  readonly value: string;
  /** What a toast or palette row shows for the copy. */
  readonly description: string;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

/** A thread chip pastes into any composer whose agent reads that thread's machine. */
export function threadChipCopyTarget(
  threadRef: ScopedThreadRef,
  title: string,
): ThreadReferenceCopyTarget {
  const record = threadContextRecord(threadRef, title);
  return {
    kind: "thread",
    value: threadDeepLink(threadRef),
    description: record.title,
    clipboardTarget: "thread",
    successTitle: "Thread copied",
    failureTitle: "Failed to copy thread",
  };
}

export function resolveThreadReferenceCopyTarget(input: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  /** Undefined means no PR panel; null means its URL is not available yet. */
  readonly openPanelPullRequestUrl?: string | null | undefined;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequestUrl?: string | null;
}): ThreadReferenceCopyTarget | null {
  if (input.openPanelPullRequestUrl === null) return null;
  const pullRequestUrl =
    input.openPanelPullRequestUrl ??
    resolveThreadCurrentPullRequestLink(input.pullRequests ?? [])?.url ??
    input.linkedPullRequestUrl;
  return pullRequestUrl
    ? {
        kind: "pull-request",
        value: pullRequestUrl,
        description: pullRequestUrl,
        clipboardTarget: "pull request link",
        successTitle: "PR link copied",
        failureTitle: "Failed to copy PR link",
      }
    : threadChipCopyTarget(input.threadRef, input.title);
}
