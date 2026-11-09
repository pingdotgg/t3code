import type {
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestMergeMethod,
  PullRequestState,
} from "@t3tools/contracts";

export const PULL_REQUEST_MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export function resolvePullRequestMergeMethod(
  allowed: ReadonlyArray<PullRequestMergeMethod>,
  current: PullRequestMergeMethod | null,
  projectDefault: PullRequestMergeMethod | undefined,
  lastSelected: PullRequestMergeMethod,
): PullRequestMergeMethod {
  for (const method of [current, projectDefault, lastSelected]) {
    if (method && allowed.includes(method)) return method;
  }
  return allowed[0] ?? "merge";
}

export function allowsSinglePullRequestMerge(input: {
  supportsStackActions: boolean;
  hasStack: boolean;
  stackPending: boolean;
  stackError: string | null;
}): boolean {
  return (
    !input.supportsStackActions ||
    (!input.hasStack && !input.stackPending && input.stackError === null)
  );
}

export type PullRequestPrimaryControl =
  | "resolve"
  | "ready"
  | "merge"
  | "enable-auto-merge"
  | "auto-merge-armed"
  | "merged"
  | "closed"
  | null;

export function resolvePullRequestPrimaryControl(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly checksState: PullRequestChecksState | null;
  readonly autoMergeEnabled: boolean | undefined;
  readonly hasMergeMethod: boolean;
  readonly canMerge: boolean;
  readonly canMarkReady: boolean;
  readonly canEnableAutoMerge: boolean;
}): PullRequestPrimaryControl {
  if (input.state === "merged") return "merged";
  if (input.state === "closed") return "closed";
  if (input.mergeability === "conflicting") return "resolve";
  if (input.isDraft) return input.canMarkReady ? "ready" : null;
  if (input.autoMergeEnabled) return "auto-merge-armed";
  if (!input.hasMergeMethod) return null;
  if (
    input.autoMergeEnabled === false &&
    input.checksState !== null &&
    input.checksState !== "passing" &&
    input.canEnableAutoMerge
  ) {
    return "enable-auto-merge";
  }
  return input.canMerge ? "merge" : null;
}

export function pullRequestShowsMergeNow(input: {
  readonly canMergeSingle: boolean;
  readonly state: PullRequestState;
  readonly primaryAction: PullRequestPrimaryControl;
  readonly canMerge: boolean;
  readonly isDraft: boolean;
  readonly conflicting: boolean;
  readonly hasMergeMethod: boolean;
}): boolean {
  return (
    input.canMergeSingle &&
    input.state === "open" &&
    (input.primaryAction === "enable-auto-merge" || input.primaryAction === "auto-merge-armed") &&
    input.canMerge &&
    !input.isDraft &&
    !input.conflicting &&
    input.hasMergeMethod
  );
}

export function pullRequestShowsAutoMerge(input: {
  readonly canMergeSingle: boolean;
  readonly state: PullRequestState;
  readonly autoMergeArmed: boolean;
  readonly canDisableAutoMerge: boolean;
  readonly canEnableAutoMerge: boolean;
  readonly primaryAction: PullRequestPrimaryControl;
  readonly isDraft: boolean;
  readonly conflicting: boolean;
  readonly hasMergeMethod: boolean;
}): boolean {
  if (input.state !== "open") return false;
  // Disabling stays available on stacks and conflicting PRs; enabling does not.
  if (input.autoMergeArmed) return input.canDisableAutoMerge;
  return (
    input.canMergeSingle &&
    input.primaryAction !== "enable-auto-merge" &&
    !input.isDraft &&
    !input.conflicting &&
    input.canEnableAutoMerge &&
    input.hasMergeMethod
  );
}

export function pullRequestPendingAutoMergeLabel(mergeMethodLabel: string): string {
  return `Auto-merge (${mergeMethodLabel.toLowerCase()})`;
}

export function pullRequestArmedAutoMergeLabel(method: PullRequestMergeMethod | undefined): string {
  return method
    ? `Auto-merge (${PULL_REQUEST_MERGE_METHOD_LABELS[method].toLowerCase()})`
    : "Auto-merge";
}
