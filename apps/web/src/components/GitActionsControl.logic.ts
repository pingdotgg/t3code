import type {
  GitRunStackedActionResult,
  GitStackedAction,
  ScopedThreadRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "../sourceControlPresentation";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr" | "prompt_ai";
  dialogAction?: GitDialogAction;
  prompt?: string;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind:
    | "run_action"
    | "run_pull"
    | "run_sync_base"
    | "open_pr"
    | "open_publish"
    | "prompt_ai"
    | "show_hint";
  action?: GitStackedAction;
  hint?: string;
  tone?: "default" | "success" | "merged" | "warning" | "destructive";
  prompt?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitAgentPromptIntent =
  | "initialize"
  | "commit"
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr"
  | "pull"
  | "sync_base"
  | "publish_repository"
  | "inspect_pr"
  | "merge_pr"
  | "resolve_conflicts"
  | "review_pr_comments"
  | "archive_merged_thread"
  | "recover_status";

export interface BuildGitAgentPromptInput {
  readonly intent: GitAgentPromptIntent;
  readonly cwd: string | null;
  readonly gitStatus: VcsStatusResult | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly commitMessage?: string;
  readonly filePaths?: readonly string[];
  readonly promptHint?: string;
  readonly unreadCommentCount?: number;
}

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

function formatChecksLabel(
  checks: NonNullable<NonNullable<VcsStatusResult["pr"]>["checks"]>,
): string {
  return `${checks.completed} / ${checks.total} Checks`;
}

function resolveChangeRequestPrompt(input: {
  action: "resolve_conflicts" | "sync_base";
  gitStatus: VcsStatusResult;
}): string {
  const pr = input.gitStatus.pr;
  const branch = input.gitStatus.refName ?? pr?.headRef ?? "the current branch";
  const baseRef = pr?.baseRef ?? "the base branch";

  if (input.action === "resolve_conflicts") {
    return [
      `Resolve the merge conflicts for ${pr ? `PR #${pr.number} (${pr.title})` : "the current pull request"}.`,
      `Current branch: ${branch}`,
      `Base branch: ${baseRef}`,
      "Update the branch safely, resolve conflicts, run the relevant checks, and commit the conflict resolution.",
    ].join("\n");
  }

  return [
    `Update ${branch} against ${baseRef}${pr ? ` for PR #${pr.number} (${pr.title})` : ""}.`,
    "Prefer a rebase when it is safe for this branch; otherwise pull/merge according to the repository's conventions.",
    "Resolve any conflicts, run the relevant checks, and push the updated branch if needed.",
  ].join("\n");
}

function isPrMergeable(pr: NonNullable<VcsStatusResult["pr"]>): boolean {
  return (
    pr.state === "open" &&
    pr.mergeStatus === "mergeable" &&
    (pr.checks === undefined || (pr.checks.pending === 0 && pr.checks.failed === 0))
  );
}

function isPrWaitingOnChecks(pr: NonNullable<VcsStatusResult["pr"]>): boolean {
  return (
    pr.state === "open" &&
    pr.mergeStatus === "mergeable" &&
    pr.checks !== undefined &&
    pr.checks.pending > 0 &&
    pr.checks.failed === 0
  );
}

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatOptional(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "unknown";
  if (typeof value === "boolean") return formatYesNo(value);
  return String(value);
}

function inferRepositoryLabel(gitStatus: VcsStatusResult | null): string {
  const prUrl = gitStatus?.pr?.url;
  if (prUrl) {
    try {
      const url = new URL(prUrl);
      const pathParts = url.pathname.split("/").filter(Boolean);
      if (url.hostname === "github.com" && pathParts.length >= 2) {
        return `${pathParts[0]}/${pathParts[1]}`;
      }
      const mergeRequestMarker = pathParts.indexOf("-");
      if (mergeRequestMarker > 0) {
        return `${url.hostname}/${pathParts.slice(0, mergeRequestMarker).join("/")}`;
      }
      if (pathParts.length >= 2) {
        return `${url.hostname}/${pathParts.slice(0, 2).join("/")}`;
      }
      return url.hostname;
    } catch {
      return "inspect with `git remote -v`";
    }
  }
  return "inspect with `git remote -v`";
}

function formatWorkingTree(gitStatus: VcsStatusResult | null): string[] {
  if (!gitStatus) return ["- Working tree: unknown"];
  const files = gitStatus.workingTree.files;
  const lines = [
    `- Working tree: ${gitStatus.hasWorkingTreeChanges ? "has local changes" : "clean"}`,
    `- Working tree totals: +${gitStatus.workingTree.insertions} / -${gitStatus.workingTree.deletions}`,
  ];
  if (files.length === 0) {
    lines.push("- Changed files: none reported");
    return lines;
  }
  lines.push("- Changed files:");
  for (const file of files.slice(0, 20)) {
    lines.push(`  - ${file.path} (+${file.insertions} / -${file.deletions})`);
  }
  if (files.length > 20) {
    lines.push(`  - ...and ${files.length - 20} more`);
  }
  return lines;
}

function formatPullRequest(gitStatus: VcsStatusResult | null): string[] {
  const pr = gitStatus?.pr;
  if (!pr) return ["- Pull request: none detected"];
  return [
    `- Pull request: #${pr.number} ${pr.title}`,
    `- Pull request URL: ${pr.url}`,
    `- Pull request state: ${pr.state}`,
    `- Pull request refs: ${pr.headRef} -> ${pr.baseRef}`,
    `- Merge status: ${formatOptional(pr.mergeStatus)}`,
    `- Checks: ${
      pr.checks
        ? `${pr.checks.completed}/${pr.checks.total} complete, ${pr.checks.successful} successful, ${pr.checks.failed} failed, ${pr.checks.pending} pending`
        : "unknown"
    }`,
  ];
}

function resolveAgentTask(input: BuildGitAgentPromptInput): string[] {
  const terms = resolveChangeRequestTerminology(input.gitStatus);
  switch (input.intent) {
    case "initialize":
      return [
        "Initialize git for this workspace.",
        "Create an initial commit only if it is appropriate after inspecting the project and repository expectations.",
      ];
    case "commit":
      return [
        "Commit the relevant local changes.",
        input.commitMessage
          ? `Use this commit message unless the diff clearly requires a safer correction: ${input.commitMessage}`
          : "Generate a concise, conventional commit message from the actual diff.",
      ];
    case "push":
      return ["Push the current branch to the correct remote/upstream."];
    case "create_pr":
      return [
        `Create a ${terms.singular} for the current branch.`,
        "Push the branch first if it has unpublished commits or no upstream.",
        `Generate a clear ${terms.shortLabel} title and body from the commits and diff.`,
      ];
    case "commit_push":
      return [
        "Commit the relevant local changes, then push the branch.",
        input.commitMessage
          ? `Use this commit message unless the diff clearly requires a safer correction: ${input.commitMessage}`
          : "Generate a concise, conventional commit message from the actual diff.",
      ];
    case "commit_push_pr":
      return [
        `Commit the relevant local changes, push the branch, and create a ${terms.singular}.`,
        input.commitMessage
          ? `Use this commit message unless the diff clearly requires a safer correction: ${input.commitMessage}`
          : "Generate a concise, conventional commit message from the actual diff.",
        `Generate a clear ${terms.shortLabel} title and body from the commits and diff.`,
      ];
    case "pull":
      return [
        "Update the current branch from upstream.",
        "Prefer a rebase when it is safe for this branch; otherwise follow this repository's conventions.",
      ];
    case "sync_base":
      return [
        "Update the current branch against its base/default branch.",
        "Prefer a rebase when it is safe; resolve conflicts carefully and push the updated branch if needed.",
      ];
    case "publish_repository":
      return [
        "Publish this local repository to GitHub or the configured source control provider.",
        "Inspect remotes first, create or select the correct remote repository, add the remote, and push the current branch.",
      ];
    case "inspect_pr":
      return [
        `Inspect the current ${terms.singular}.`,
        "Summarize state, checks, review comments, and any required follow-up work.",
      ];
    case "merge_pr":
      return [
        `Verify the current ${terms.singular} is safe to merge, then merge it if appropriate.`,
        "Confirm checks, review state, base/head refs, and repository policy before merging.",
      ];
    case "resolve_conflicts":
      return [
        `Resolve merge conflicts for the current ${terms.singular}.`,
        "Update from the base branch, resolve conflicts, run relevant checks, commit the conflict resolution, and push.",
      ];
    case "review_pr_comments":
      return [
        `Review and address ${input.unreadCommentCount ? `${input.unreadCommentCount} unread ` : ""}${terms.shortLabel} comments.`,
        "Fetch review comments, identify actionable feedback, implement fixes, run relevant checks, commit, and push.",
      ];
    case "archive_merged_thread":
      return [
        `The ${terms.singular} appears to be merged. Verify final GitHub state and clean up anything appropriate.`,
        "If the work is complete, summarize whether this T3 Code thread can be archived.",
      ];
    case "recover_status":
      return [
        "Inspect and recover the git/source-control state for this workspace.",
        "Report what is blocking the normal GitHub workflow and fix it when safe.",
      ];
  }
}

export function buildGitAgentPrompt(input: BuildGitAgentPromptInput): string {
  const gitStatus = input.gitStatus;
  const provider = gitStatus?.sourceControlProvider;
  const selectedFiles = input.filePaths?.filter((path) => path.trim().length > 0) ?? [];
  const taskLines = resolveAgentTask(input);
  const lines = [
    "Handle this Git/GitHub workflow from the current workspace.",
    "",
    "Task:",
    ...taskLines.map((line) => `- ${line}`),
    "",
    "Workspace and repo context:",
    `- Workspace path: ${formatOptional(input.cwd)}`,
    `- Environment id: ${formatOptional(input.threadRef?.environmentId)}`,
    `- Thread id: ${formatOptional(input.threadRef?.threadId)}`,
    `- Repository: ${inferRepositoryLabel(gitStatus)}`,
    `- Source control provider: ${provider ? `${provider.name} (${provider.kind}, ${provider.baseUrl})` : "unknown"}`,
    `- Is git repository: ${gitStatus ? formatYesNo(gitStatus.isRepo) : "unknown"}`,
    `- Has primary remote: ${gitStatus ? formatYesNo(gitStatus.hasPrimaryRemote) : "unknown"}`,
    "",
    "Branch context:",
    `- Current ref: ${formatOptional(gitStatus?.refName)}`,
    `- Default ref: ${gitStatus ? formatYesNo(gitStatus.isDefaultRef) : "unknown"}`,
    `- Has upstream: ${gitStatus ? formatYesNo(gitStatus.hasUpstream) : "unknown"}`,
    `- Ahead/behind upstream: ${formatOptional(gitStatus?.aheadCount)} ahead / ${formatOptional(gitStatus?.behindCount)} behind`,
    `- Ahead/behind base: ${formatOptional(gitStatus?.aheadOfDefaultCount)} ahead / ${formatOptional(gitStatus?.behindOfDefaultCount)} behind`,
    "",
    "Local changes:",
    ...formatWorkingTree(gitStatus),
    ...(selectedFiles.length > 0
      ? ["- User-selected file scope:", ...selectedFiles.map((path) => `  - ${path}`)]
      : []),
    "",
    "Pull request context:",
    ...formatPullRequest(gitStatus),
    "",
    "Operational requirements:",
    "- Start by inspecting `git status --short --branch`, `git remote -v`, and the relevant branch/upstream configuration.",
    "- Use GitHub CLI or the configured source-control tooling for provider interactions when available.",
    "- Do not force-push unless it is clearly required and safe; explain before doing it.",
    "- Keep commits focused. Do not include unrelated files.",
    "- Run the relevant lightweight checks for the touched code before reporting completion.",
    "- Report exactly what changed, what was pushed, and any pull request URL or remaining blocker.",
  ];

  if (input.promptHint?.trim()) {
    lines.push("", "Additional context:", input.promptHint.trim());
  }

  return lines.join("\n");
}

export function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
  hasWorkingTreeChanges: boolean;
  pushTarget?: string;
  featureBranch?: boolean;
  shouldPushBeforePr?: boolean;
  terminology?: ChangeRequestTerminology;
}): string[] {
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  const branchStages = input.featureBranch ? ["Preparing feature ref..."] : [];
  const pushStage = input.pushTarget ? `Pushing to ${input.pushTarget}...` : "Pushing...";
  const prStages = [
    `Preparing ${terminology.shortLabel}...`,
    `Generating ${terminology.shortLabel} content...`,
    `Creating ${terminology.singular}...`,
  ];

  if (input.action === "push") {
    return [pushStage];
  }
  if (input.action === "create_pr") {
    return input.shouldPushBeforePr ? [pushStage, ...prStages] : prStages;
  }

  const shouldIncludeCommitStages = input.action === "commit" || input.hasWorkingTreeChanges;
  const commitStages = !shouldIncludeCommitStages
    ? []
    : input.hasCustomCommitMessage
      ? ["Committing..."]
      : ["Generating commit message...", "Committing..."];
  if (input.action === "commit") {
    return [...branchStages, ...commitStages];
  }
  if (input.action === "commit_push") {
    return [...branchStages, ...commitStages, pushStage];
  }
  return [...branchStages, ...commitStages, pushStage, ...prStages];
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = resolveChangeRequestTerminology(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const isBehindBase = (gitStatus.behindOfDefaultCount ?? 0) > 0 && !gitStatus.isDefaultRef;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    !isBehindBase &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    !isBehindBase &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const prItemLabel = (() => {
    const pr = gitStatus.pr;
    if (!pr) return `Create ${terminology.shortLabel}`;
    if (pr.state === "merged") return "Merged";
    return `View ${terminology.shortLabel}`;
  })();

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  return [
    commitItem,
    {
      id: "push",
      label: "Push",
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    gitStatus.pr
      ? {
          id: "pr",
          label: prItemLabel,
          disabled: false,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: `Create ${terminology.shortLabel}`,
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
  const pr = gitStatus.pr;
  const hasOpenPr = pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isBehindBase = (gitStatus.behindOfDefaultCount ?? 0) > 0 && !isDefaultRef;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `Create and checkout a ref before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (pr?.state === "merged") {
    return { label: "Merged", disabled: false, kind: "open_pr", tone: "merged" };
  }

  if (isDiverged) {
    return {
      label: "Rebase / pull",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
      tone: "warning",
    };
  }

  if (isBehind) {
    return {
      label: "Rebase / pull",
      disabled: false,
      kind: "run_pull",
      tone: "warning",
    };
  }

  if (hasOpenPr && pr?.mergeStatus === "conflicting") {
    return {
      label: "Resolve conflicts",
      disabled: false,
      kind: "prompt_ai",
      prompt: resolveChangeRequestPrompt({ action: "resolve_conflicts", gitStatus }),
      tone: "destructive",
    };
  }

  if (hasOpenPr && pr?.mergeStatus === "behind") {
    return {
      label: "Rebase / pull",
      disabled: false,
      kind: "prompt_ai",
      prompt: resolveChangeRequestPrompt({ action: "sync_base", gitStatus }),
      tone: "warning",
    };
  }

  if (isBehindBase) {
    if (hasChanges) {
      return {
        label: "Update from base",
        disabled: true,
        kind: "show_hint",
        hint: "Commit or stash local changes before updating from the base branch.",
        tone: "warning",
      };
    }
    return {
      label: "Update from base",
      disabled: false,
      kind: "run_sync_base",
      tone: "warning",
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Commit and push",
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: `Commit, push & ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (hasOpenPr && pr?.checks && pr.checks.pending > 0) {
    return {
      label: formatChecksLabel(pr.checks),
      disabled: !isPrWaitingOnChecks(pr),
      kind: isPrWaitingOnChecks(pr) ? "open_pr" : "show_hint",
      hint: "Checks are still running.",
      tone: "warning",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) {
        if (pr && isPrMergeable(pr)) {
          return { label: "Merge", disabled: false, kind: "open_pr", tone: "success" };
        }
        return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
      }
      return {
        label: "Publish repository",
        disabled: false,
        kind: "open_publish",
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        if (pr && isPrMergeable(pr)) {
          return { label: "Merge", disabled: false, kind: "open_pr", tone: "success" };
        }
        return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
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
    if (pr && isPrMergeable(pr)) {
      return { label: "Merge", disabled: false, kind: "open_pr", tone: "success" };
    }
    return { label: `View ${terminology.shortLabel}`, disabled: false, kind: "open_pr" };
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

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology?: ChangeRequestTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const suffix = ` on "${branchLabel}". You can continue on this ref or create a feature ref and run the same action there.`;
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;

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

// Re-export from shared for backwards compatibility in this module's exports
export { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
