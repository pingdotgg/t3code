export interface ThreadReferenceCopyTarget {
  readonly kind: "pull-request" | "thread";
  readonly value: string;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

export function resolveThreadReferenceCopyTarget(input: {
  readonly threadId: string;
  /** Undefined means no PR panel; null means its URL is not available yet. */
  readonly openPanelPullRequestUrl?: string | null | undefined;
  readonly linkedPullRequestUrl?: string | null;
  readonly detectedPullRequestUrl?: string | null;
}): ThreadReferenceCopyTarget | null {
  if (input.openPanelPullRequestUrl === null) return null;
  const pullRequestUrl =
    input.openPanelPullRequestUrl ?? input.linkedPullRequestUrl ?? input.detectedPullRequestUrl;
  return pullRequestUrl
    ? {
        kind: "pull-request",
        value: pullRequestUrl,
        clipboardTarget: "pull request link",
        successTitle: "PR link copied",
        failureTitle: "Failed to copy PR link",
      }
    : {
        kind: "thread",
        value: input.threadId,
        clipboardTarget: "thread ID",
        successTitle: "Thread ID copied",
        failureTitle: "Failed to copy thread ID",
      };
}
