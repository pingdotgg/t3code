/**
 * Shown in place of success when a checkout is not confirmed on the pull request's head, by both
 * the pull request panel and the branch picker's checkout dialog.
 */
export const OFF_HEAD_PULL_REQUEST_CHECKOUT_TOAST = {
  type: "warning",
  title: "Checked out, but not confirmed on the latest commit",
  description:
    "This checkout could not be confirmed at the pull request's latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
} as const;
