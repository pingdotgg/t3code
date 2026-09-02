import type { ShellGitState } from "@t3tools/contracts/shell";
import { useMemo } from "react";

import { useShellActions } from "./useShellActions";
import { useShellPublish } from "./useShellPublish";

import {
  getMenuActionDisabledReason,
  requestVcsStatusRefresh,
  type useGitActions,
} from "../hooks/useGitActions";

export interface ShellGitBridgeProps {
  readonly git: ReturnType<typeof useGitActions>;
  readonly gitCwd: string | null;
  readonly onOpenPublish: () => void;
}

/**
 * Mounted by GitActionsControl when the Qt shell hosts the app. Publishes the
 * git model and runs the same hook methods the HTML buttons call; the commit
 * and default-branch dialogs are rendered by the shell from the state.
 */
export function ShellGitBridge({ git, gitCwd, onOpenPublish }: ShellGitBridgeProps) {
  const status = git.gitStatusForActions ?? null;
  const state = useMemo((): ShellGitState => {
    const hints: string[] = [];
    if (status && status.isRepo && status.refName === null) {
      hints.push("Detached HEAD: check out a branch to push or open a pull request.");
    }
    if (status && status.behindCount > 0) {
      hints.push(`Behind upstream by ${status.behindCount} — pull or rebase before pushing.`);
    }
    if (git.gitStatusError) {
      hints.push(String(git.gitStatusError));
    }
    return {
      available: gitCwd !== null,
      isRepo: git.isRepo,
      busy: git.isGitActionRunning,
      initPending: git.initAction.isPending,
      quickAction: {
        label: git.quickAction.label,
        disabledReason: git.quickActionDisabledReason,
        kind: git.quickAction.kind,
      },
      menu: git.gitActionMenuItems.map((item) => ({
        id: item.id,
        label: item.label,
        disabledReason: getMenuActionDisabledReason({
          item,
          gitStatus: status,
          isBusy: git.isGitActionRunning,
          hasPrimaryRemote: git.hasPrimaryRemote,
        }),
      })),
      canPublish: git.isRepo && status !== null && !git.hasPrimaryRemote,
      hints,
      branch: status?.refName ?? null,
      isDefaultRef: git.isDefaultRef,
      files: git.allFiles.map((file) => ({
        path: file.path,
        insertions: file.insertions,
        deletions: file.deletions,
      })),
      pendingDefaultBranch:
        git.pendingDefaultBranchAction && git.pendingDefaultBranchActionCopy
          ? {
              title: git.pendingDefaultBranchActionCopy.title,
              description: git.pendingDefaultBranchActionCopy.description,
              continueLabel: git.pendingDefaultBranchActionCopy.continueLabel,
              featureBranchLabel: "Checkout feature branch & continue",
            }
          : null,
    };
  }, [git, gitCwd, status]);

  useShellPublish("git", state);

  useShellActions((action) => {
    switch (action.type) {
      case "git.quick":
        git.runQuickAction();
        return;
      case "git.menu": {
        const item = git.gitActionMenuItems.find((entry) => entry.id === action.id);
        if (!item) return;
        // "commit" needs a dialog; the shell renders its own from the
        // published files and comes back with `git.commit`.
        git.runMenuItemAction(item);
        return;
      }
      case "git.init":
        void git.initRepository();
        return;
      case "git.publish":
        onOpenPublish();
        return;
      case "git.refresh":
        requestVcsStatusRefresh(git.refreshVcsStatus, git.activeEnvironmentId, gitCwd);
        return;
      case "git.commit":
        void git.runGitActionWithToast({
          action: "commit",
          ...(action.message.trim() ? { commitMessage: action.message.trim() } : {}),
          ...(action.filePaths ? { filePaths: [...action.filePaths] } : {}),
          ...(action.featureBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
        });
        return;
      case "git.defaultBranch":
        if (action.choice === "abort") git.dismissPendingDefaultBranchAction();
        else if (action.choice === "continue") git.continuePendingDefaultBranchAction();
        else git.checkoutFeatureBranchAndContinuePendingAction();
        return;
      default:
        return;
    }
  });

  return null;
}
