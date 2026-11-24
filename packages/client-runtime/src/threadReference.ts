import type {
  ComposerContextClipboardFragment,
  ScopedThreadRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { shareableThreadLink } from "@t3tools/shared/threadLinks";

import { resolveThreadCurrentPullRequestLink } from "./threadPullRequests.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface ThreadReferenceCopyTarget {
  readonly kind: "pull-request" | "thread";
  /** The plain text: a PR URL, or a link that opens the thread on its server. */
  readonly value: string;
  /** What a toast or palette row shows for the copy. */
  readonly description: string;
  /** T3's clipboard format, which pastes a thread back into a composer as a chip. */
  readonly fragment?: ComposerContextClipboardFragment;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

/**
 * A link that opens the thread on its server's web app at `linkOrigin`, or in the installed app
 * without one. It pastes back as a chip into any composer whose agent reads that thread's machine.
 */
export function threadChipCopyTarget(
  threadRef: ScopedThreadRef,
  title: string,
  linkOrigin: string | null,
  resolve: MFunctionType = mFallback,
): ThreadReferenceCopyTarget {
  const record = threadContextRecord(threadRef, title);
  return {
    kind: "thread",
    value: shareableThreadLink(threadRef, linkOrigin),
    description: record.title,
    fragment: { version: 1, source: { environmentId: threadRef.environmentId }, records: [record] },
    clipboardTarget: "thread",
    successTitle: resolve(msg("Thread copied")),
    failureTitle: resolve(msg("Failed to copy thread")),
  };
}

export function resolveThreadReferenceCopyTarget(
  input: {
    readonly threadRef: ScopedThreadRef;
    readonly title: string;
    /** Undefined means no PR panel; null means its URL is not available yet. */
    readonly openPanelPullRequestUrl?: string | null | undefined;
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
    readonly linkedPullRequestUrl?: string | null;
    readonly linkOrigin: string | null;
  },
  resolve: MFunctionType = mFallback,
): ThreadReferenceCopyTarget | null {
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
        successTitle: resolve(msg("PR link copied")),
        failureTitle: resolve(msg("Failed to copy PR link")),
      }
    : threadChipCopyTarget(input.threadRef, input.title, input.linkOrigin, resolve);
}
