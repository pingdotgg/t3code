import type {
  ComposerContextClipboardFragment,
  ScopedThreadRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { hostedThreadLink } from "@t3tools/shared/threadLinks";

import { resolveThreadCurrentPullRequestLink } from "./threadPullRequests.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export interface ThreadReferenceCopyTarget {
  readonly kind: "pull-request" | "thread";
  /** The plain text: a PR URL, or a link that opens the thread from anywhere. */
  readonly value: string;
  /** What a toast or palette row shows for the copy. */
  readonly description: string;
  /** T3's clipboard format, which pastes a thread back into a composer as a chip. */
  readonly fragment?: ComposerContextClipboardFragment;
  readonly clipboardTarget: string;
  readonly successTitle: string;
  readonly failureTitle: string;
}

interface ThreadChip {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

/**
 * A link that opens the thread from anywhere, through `hostedAppUrl`, this build's hosted app. It
 * pastes back as a chip into any composer whose agent reads that thread's machine.
 */
export function threadChipCopyTarget(
  threadRef: ScopedThreadRef,
  title: string,
  hostedAppUrl?: string,
  resolve: MFunctionType = mFallback,
): ThreadReferenceCopyTarget {
  return threadChipsCopyTarget([{ threadRef, title }], hostedAppUrl, resolve);
}

/** Each chip carries its own machine, so a selection may span environments. */
export function threadChipsCopyTarget(
  threads: readonly [ThreadChip, ...ThreadChip[]],
  hostedAppUrl?: string,
  resolve: MFunctionType = mFallback,
): ThreadReferenceCopyTarget {
  const records = threads.map(({ threadRef, title }) => threadContextRecord(threadRef, title));
  const single = records.length === 1;
  return {
    kind: "thread",
    value: threads.map(({ threadRef }) => hostedThreadLink(threadRef, hostedAppUrl)).join("\n"),
    description: records.map((record) => record.title).join(", "),
    fragment: {
      version: 1,
      source: { environmentId: threads[0].threadRef.environmentId },
      records,
    },
    clipboardTarget: single ? "thread" : "threads",
    successTitle: single
      ? resolve(msg("Thread copied"))
      : resolve(msg("{count} threads copied", { count: records.length })),
    failureTitle: single
      ? resolve(msg("Failed to copy thread"))
      : resolve(msg("Failed to copy threads")),
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
    readonly hostedAppUrl?: string;
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
    : threadChipCopyTarget(input.threadRef, input.title, input.hostedAppUrl, resolve);
}
