import type { PullRequestReviewer } from "@t3tools/contracts";

export function pullRequestReviewerState(state: PullRequestReviewer["reviewState"]) {
  switch (state) {
    case "approved":
      return { label: "Approved", outcome: "approved" } as const;
    case "approved-with-suggestions":
      return { label: "Approved with suggestions", outcome: "approved" } as const;
    case "waiting-for-author":
      return { label: "Waiting for author", outcome: "changes-requested" } as const;
    case "rejected":
      return { label: "Rejected", outcome: "changes-requested" } as const;
    case "none":
      return { label: "No review yet", outcome: null } as const;
    case undefined:
      return undefined;
  }
}
