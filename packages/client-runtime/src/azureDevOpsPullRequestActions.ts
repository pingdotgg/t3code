import {
  AzureDevOpsMergeStrategy,
  type AzureDevOpsReviewVote,
  type PullRequestDetail,
  type PullRequestHostAction,
  type PullRequestHostDetails,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";

type MergeStrategy = typeof AzureDevOpsMergeStrategy.Type;
type Denied = Readonly<Record<string, string | undefined>>;

export const azureVoteLabels: Record<AzureDevOpsReviewVote, string> = {
  approve: "Approve",
  "approve-with-suggestions": "Approve with suggestions",
  "wait-for-author": "Wait for author",
  reject: "Reject",
  reset: "Reset feedback",
};
export const azureMergeStrategyLabels: Record<MergeStrategy, string> = {
  noFastForward: "Merge (no fast forward)",
  squash: "Squash commit",
  rebase: "Rebase and fast-forward",
  rebaseMerge: "Semi-linear merge",
};
export const azureActionSections = [
  "Reviewers",
  "Tags",
  "Linked work items",
  "Attachments",
  "Share by email",
  "Policies and checks",
  "Branches",
  "Completion options",
] as const;
export type AzureActionSection = (typeof azureActionSections)[number];

export type AzureCompletionOptions = Omit<
  Extract<PullRequestHostAction, { type: "complete" }>,
  "type" | "automatic"
>;
/** A completion form whose strategy stays null until the reader picks one. */
export type AzureCompletionDraft = Omit<AzureCompletionOptions, "strategy"> & {
  readonly strategy: MergeStrategy | null;
};
export const emptyAzureCompletionDraft: AzureCompletionDraft = {
  strategy: null,
  deleteSourceBranch: false,
  transitionWorkItems: false,
  waitForOptionalPolicies: false,
  bypassPolicy: false,
  bypassReason: "",
  message: "",
};
export const azureCompletionToggles: ReadonlyArray<{
  readonly key:
    | "deleteSourceBranch"
    | "transitionWorkItems"
    | "waitForOptionalPolicies"
    | "bypassPolicy";
  readonly label: string;
  readonly permission?: "delete-source" | "bypass-policy";
}> = [
  {
    key: "deleteSourceBranch",
    label: "Delete source branch after merging",
    permission: "delete-source",
  },
  { key: "transitionWorkItems", label: "Complete linked work items" },
  { key: "waitForOptionalPolicies", label: "Wait for optional policies" },
  { key: "bypassPolicy", label: "Override branch policies", permission: "bypass-policy" },
];

const armedStrategies: Record<PullRequestMergeMethod, readonly MergeStrategy[]> = {
  merge: ["noFastForward"],
  squash: ["squash"],
  rebase: ["rebase", "rebaseMerge"],
};

/**
 * Fills in the strategy the reader has not picked: an armed auto-complete's when policy allows it,
 * otherwise the first strategy policy allows. A deliberate pick is kept even when policy refuses it.
 */
export function azureCompletionOptions(
  draft: AzureCompletionDraft,
  allowed: readonly MergeStrategy[] | undefined,
  armed: PullRequestMergeMethod | undefined,
): AzureCompletionOptions {
  const preferred = armed === undefined ? [] : armedStrategies[armed];
  const strategy =
    draft.strategy ??
    [...preferred, ...AzureDevOpsMergeStrategy.literals].find(
      (candidate) => allowed?.includes(candidate) ?? true,
    ) ??
    preferred[0] ??
    "noFastForward";
  return { ...draft, strategy };
}

/** Why completing or arming auto-complete would be refused, mirroring the server's guards. */
export function azureCompletionBlock(
  options: AzureCompletionOptions,
  pr: Pick<PullRequestDetail, "state" | "isDraft">,
  denied: Denied,
  allowed: readonly MergeStrategy[] | undefined,
): string | undefined {
  if (pr.state !== "open") return "Only an open pull request can be completed.";
  if (pr.isDraft) return "Publish this draft before completing it.";
  if (denied.complete) return denied.complete;
  if (options.deleteSourceBranch && denied["delete-source"]) return denied["delete-source"];
  if (options.bypassPolicy) {
    return (
      denied["bypass-policy"] ??
      (options.bypassReason.trim() ? undefined : "Enter a reason for overriding branch policies.")
    );
  }
  return allowed && !allowed.includes(options.strategy)
    ? "Branch policy does not allow this merge strategy."
    : undefined;
}

/** The branch actions the typed names allow, each null until its inputs are usable. */
export function azureBranchActions(
  pr: Pick<PullRequestDetail, "state" | "baseBranch">,
  targetBranch: string,
  newBranch: string,
) {
  const target = targetBranch.trim();
  const created = newBranch.trim();
  const copy =
    target && created
      ? { createPullRequest: true, targetBranch: target, newBranch: created }
      : null;
  return {
    retarget:
      pr.state === "open" && target && target !== pr.baseBranch
        ? { type: "retarget" as const, branch: target }
        : null,
    cherryPick: copy ? { type: "cherry-pick" as const, ...copy } : null,
    revert: copy && pr.state === "merged" ? { type: "revert" as const, ...copy } : null,
  };
}

export const splitAzureList = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Work item numbers typed as a list, or null when any is not one Azure would accept. */
export function parseAzureWorkItemIds(text: string): number[] | null {
  const values = splitAzureList(text);
  return values.length > 0 &&
    values.length <= 25 &&
    values.every((value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)))
    ? values.map(Number)
    : null;
}

const voteStatus = new Map([
  [10, "Approved"],
  [5, "Approved with suggestions"],
  [-5, "Waiting for author"],
  [-10, "Rejected"],
]);
export function azureReviewerStatus(reviewer: PullRequestHostDetails["reviewers"][number]) {
  return [
    voteStatus.get(reviewer.vote) ?? "No vote",
    reviewer.required ? "Required" : null,
    reviewer.declined ? "Declined" : null,
    reviewer.flagged ? "Flagged" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
