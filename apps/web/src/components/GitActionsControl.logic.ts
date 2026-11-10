import type {
  GitRunStackedActionResult,
  GitStackedAction,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
  VcsStatusResult,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  threadPullRequestKeyOf,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  changeRequestTerminologyFor,
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
  type GitDialogAction,
} from "@t3tools/client-runtime/state/vcs";

export {
  requiresDefaultBranchConfirmation,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
} from "@t3tools/client-runtime/state/vcs";

export interface GitActionMenuItem {
  id: "branch" | "commit" | "commit_dialog" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "run_action";
  action?: GitStackedAction;
  featureBranch?: boolean;
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind:
    | "run_action"
    | "run_pull"
    | "open_publish"
    | "create_branch"
    | "open_commit_dialog"
    | "open_push_dialog"
    | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function canRewriteCommitMessages(gitStatus: VcsStatusResult | null): boolean {
  if (!gitStatus || gitStatus.refName === null) {
    return false;
  }
  return Math.max(gitStatus.aheadCount, gitStatus.aheadOfDefaultCount ?? 0) > 0;
}

export interface RegeneratePullRequestCandidate {
  readonly url: string;
  readonly number: number;
  readonly title: string;
  readonly repository: string;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
}

export function resolveRegeneratePullRequestCandidates(
  gitStatus: VcsStatusResult | null,
  thread: {
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
    readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  } | null,
): ReadonlyArray<RegeneratePullRequestCandidate> {
  const candidates = new Map<string, RegeneratePullRequestCandidate>();
  const branchPr = gitStatus?.pr;
  const branchReference = branchPr
    ? sourceControlClients.parseChangeRequestUrl(branchPr.url)?.link
    : null;
  if (branchPr?.state === "open" && branchReference) {
    candidates.set(threadPullRequestKeyOf(branchReference), {
      url: branchPr.url,
      number: branchPr.number,
      title: branchPr.title,
      repository: branchReference.repository,
      headBranch: branchPr.headRef,
      baseBranch: branchPr.baseRef,
    });
  }
  for (const link of visibleThreadPullRequests(threadPullRequestsOf(thread ?? {}))) {
    if (link.snapshot !== null && link.snapshot.state !== "open") continue;
    const key = threadPullRequestKeyOf(link);
    if (candidates.has(key)) continue;
    candidates.set(key, {
      url: link.url,
      number: link.number,
      title: link.snapshot?.title ?? link.repository,
      repository: link.repository,
      headBranch: link.snapshot?.headBranch ?? null,
      baseBranch: link.snapshot?.baseBranch ?? null,
    });
  }
  return [...candidates.values()];
}

export function resolveGitActionProgressPresentation(input: {
  readonly isRunning: boolean;
  readonly operation: string | null;
  readonly currentLabel: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
}): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" &&
      input.operation !== "pull" &&
      input.operation !== "split_commits")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? currentLabel
        : isPull
          ? "Pulling latest changes..."
          : "Starting source control action...",
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(startedAtMs: number | null, nowMs: number): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const needsFeatureBranch = !hasBranch || gitStatus.isDefaultRef;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasPrimaryRemote &&
    (needsFeatureBranch || gitStatus.aheadCount > 0 || hasChanges) &&
    (needsFeatureBranch ||
      (isBehind
        ? !hasChanges && gitStatus.hasUpstream
        : gitStatus.hasUpstream || canPushWithoutUpstream));
  const canCreatePr =
    !isBusy &&
    !hasOpenPr &&
    (hasDefaultBranchDelta || hasChanges || !hasBranch) &&
    (needsFeatureBranch || !isBehind) &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const branchItems: GitActionMenuItem[] = needsFeatureBranch
    ? [
        {
          id: "branch",
          label: "Create feature branch",
          disabled: isBusy,
          icon: "branch",
          kind: "run_action",
          action: "create_branch",
          featureBranch: true,
        },
      ]
    : [];
  const commitItems: GitActionMenuItem[] = [
    {
      id: "commit",
      label: "Commit",
      disabled: !canCommit,
      icon: "commit",
      kind: "run_action",
      action: "commit",
      ...(needsFeatureBranch ? { featureBranch: true } : {}),
    },
    {
      id: "commit_dialog",
      label: "Commit dialog",
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
  ];

  if (!hasPrimaryRemote) {
    return [...branchItems, ...commitItems];
  }

  const pushItem: GitActionMenuItem = {
    id: "push",
    label: hasChanges ? "Commit & push" : "Push",
    action: "commit_push",
    ...(needsFeatureBranch ? { featureBranch: true } : {}),
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  };

  if (hasOpenPr) {
    return [...branchItems, ...commitItems, pushItem];
  }

  return [
    ...branchItems,
    ...commitItems,
    pushItem,
    {
      id: "pr",
      label: hasChanges
        ? `Commit, push & create ${terminology.shortLabel}`
        : `Create ${terminology.shortLabel}`,
      action: "commit_push_pr",
      ...(needsFeatureBranch ? { featureBranch: true } : {}),
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
): GitQuickAction {
  if (isBusy) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: "Git action in progress." };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (!hasBranch) {
    return {
      label: "Create feature branch",
      disabled: false,
      kind: "create_branch",
    };
  }

  if (hasChanges) {
    if (isDefaultRef) {
      return { label: "Commit", disabled: false, kind: "open_commit_dialog" };
    }
    return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      return {
        label: "Publish repository",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: "Commit",
          disabled: true,
          kind: "show_hint",
          hint: "Branch is up to date. No action needed.",
        };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: "Push",
      disabled: false,
      kind: "open_push_dialog",
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}

export function requiresForcePushConfirmation(gitStatus: VcsStatusResult | null): boolean {
  return (
    gitStatus !== null &&
    gitStatus.refName !== null &&
    gitStatus.hasUpstream &&
    !gitStatus.hasWorkingTreeChanges &&
    gitStatus.aheadCount > 0 &&
    gitStatus.behindCount > 0
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this ref or create a feature ref and run the same action there.`;
  const { terminology } = input;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: "Commit & push to default ref?",
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branchLabel}`,
      };
    }
    return {
      title: "Push to default ref?",
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ref?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ref?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}

/** Clean trees cannot create feature branches because the server derives names from uncommitted changes. */
export function resolveFeatureBranchUnavailableReason(input: {
  branchName: string;
  hasWorkingTreeChanges: boolean;
}): string | null {
  if (input.hasWorkingTreeChanges) return null;
  return `There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on ${input.branchName}.`;
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export interface PendingThreadBranchSync {
  readonly threadId: string;
  readonly expectedBranch: string | null;
  readonly branch: string | null;
}

export function isDuplicatePendingThreadBranchSync(
  pending: PendingThreadBranchSync | null,
  input: PendingThreadBranchSync,
): boolean {
  return (
    pending !== null &&
    pending.threadId === input.threadId &&
    pending.expectedBranch === input.expectedBranch &&
    pending.branch === input.branch
  );
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
  /** Ref the counts compare against; `null` means they are uncommitted changes against HEAD. */
  readonly baseRef: string | null;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
): ChangesLineTotals | null {
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null };
  const selected =
    branch && (branch.insertions > 0 || branch.deletions > 0)
      ? branch
      : tree.insertions > 0 || tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    insertions: selected.insertions,
    deletions: selected.deletions,
    baseRef: selected.baseRef,
  };
}
