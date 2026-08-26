import { ShellAction, type ShellGitState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

import {
  getMenuActionDisabledReason,
  requestVcsStatusRefresh,
  type useGitActions,
} from "../hooks/useGitActions";

const isShellAction = Schema.is(ShellAction);

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
  const shell = window.t3Shell;
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

  useEffect(() => {
    if (!shell) return;
    void shell.publish("git", state);
  }, [shell, state]);
  useEffect(() => {
    if (!shell) return;
    return () => {
      void shell.publish("git", null);
    };
  }, [shell]);

  const latest = useRef({ git, gitCwd, onOpenPublish });
  latest.current = { git, gitCwd, onOpenPublish };
  useEffect(() => {
    if (!shell) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void shell
      .onAction((type, payload) => {
        const candidate = {
          ...(typeof payload === "object" && payload !== null ? payload : {}),
          type,
        };
        if (!isShellAction(candidate)) return;
        const { git: current, gitCwd: cwd, onOpenPublish: openPublish } = latest.current;
        switch (candidate.type) {
          case "git.quick":
            current.runQuickAction();
            return;
          case "git.menu": {
            const item = current.gitActionMenuItems.find((entry) => entry.id === candidate.id);
            if (!item) return;
            if (current.resolveMenuItemAction(item) === "commit") {
              // The shell opens its commit dialog from the published files.
            }
            return;
          }
          case "git.init":
            void current.initAction.run();
            return;
          case "git.publish":
            openPublish();
            return;
          case "git.refresh":
            requestVcsStatusRefresh(current.refreshVcsStatus, current.activeEnvironmentId, cwd);
            return;
          case "git.commit":
            void current.runGitActionWithToast({
              action: "commit",
              ...(candidate.message.trim() ? { commitMessage: candidate.message.trim() } : {}),
              ...(candidate.filePaths ? { filePaths: [...candidate.filePaths] } : {}),
              ...(candidate.featureBranch
                ? { featureBranch: true, skipDefaultBranchPrompt: true }
                : {}),
            });
            return;
          case "git.defaultBranch":
            if (candidate.choice === "abort") current.dismissPendingDefaultBranchAction();
            else if (candidate.choice === "continue") current.continuePendingDefaultBranchAction();
            else current.checkoutFeatureBranchAndContinuePendingAction();
            return;
          default:
            return;
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unsubscribe = dispose;
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [shell]);

  return null;
}
