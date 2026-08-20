/**
 * The inbox is the unsettled group: the threads a client shows above the
 * snoozed and settled shelves. This module owns the one rule for calling it
 * empty, and the copy that rule selects, so web and mobile cannot drift apart
 * on either.
 */

export const EMPTY_INBOX_HEADLINE = "You're all caught up";
export const EMPTY_INBOX_PARKED_DETAIL = "Everything's handled. Enjoy the quiet.";
export const EMPTY_INBOX_ACTION_LABEL = "New thread";

export function emptyInboxScopedHeadline(projectName: string): string {
  return `${EMPTY_INBOX_HEADLINE} in ${projectName}`;
}

/**
 * Whether nothing live sits above the snoozed shelf. Pinned threads and
 * drafts count: both are work in progress, so the block would contradict
 * itself rendering underneath them.
 */
export function isInboxClear(counts: {
  readonly active: number;
  readonly pinned: number;
  readonly drafts: number;
}): boolean {
  return counts.active + counts.pinned + counts.drafts === 0;
}

export interface EmptyInboxCopy {
  readonly headline: string;
  /** Absent when nothing is parked, so a brand-new project is not told it
   * finished work it never had. */
  readonly detail: string | undefined;
  readonly actionLabel: string;
}

export function emptyInboxCopy(input: {
  /** Project the list is filtered to, or null when it shows everything. */
  readonly projectName: string | null;
  /** Settled rows plus snoozed rows. */
  readonly parkedCount: number;
}): EmptyInboxCopy {
  return {
    headline:
      input.projectName === null || input.projectName.length === 0
        ? EMPTY_INBOX_HEADLINE
        : emptyInboxScopedHeadline(input.projectName),
    detail: input.parkedCount > 0 ? EMPTY_INBOX_PARKED_DETAIL : undefined,
    actionLabel: EMPTY_INBOX_ACTION_LABEL,
  };
}
