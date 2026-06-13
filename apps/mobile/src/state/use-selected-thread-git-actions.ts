import { useCallback, useEffect } from "react";

import {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
  type VcsRef,
  type GitActionRequestInput,
} from "@t3tools/client-runtime";
import { CommandId, type GitRunStackedActionResult } from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";

import { uuidv4 } from "../lib/uuid";
import { getEnvironmentClient } from "./environment-session-registry";
import { setPendingConnectionError } from "./use-remote-environment-registry";
import { vcsActionManager, showGitActionResult } from "./use-vcs-action-state";
import { vcsRefManager } from "./use-vcs-refs";
import { vcsStatusManager } from "./use-vcs-status";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

export function useSelectedThreadGitActions() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();

  const selectedThreadGitRootCwd = selectedThreadProject?.workspaceRoot ?? null;

  const updateThreadGitContext = useCallback(
    async (
      thread: NonNullable<typeof selectedThread>,
      nextState: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      },
    ) => {
      const client = getEnvironmentClient(thread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make(uuidv4()),
        threadId: thread.id,
        ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
        ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
      });
    },
    [],
  );

  const refreshSelectedThreadGitStatus = useCallback(
    async (options?: { readonly quiet?: boolean; readonly cwd?: string | null }) => {
      if (!selectedThread || !selectedThreadProject) {
        return null;
      }

      const cwd = options?.cwd ?? selectedThreadCwd;
      if (!cwd) {
        return null;
      }

      try {
        const client = getEnvironmentClient(selectedThread.environmentId);
        if (!client) {
          return null;
        }

        const status = await vcsActionManager.refreshStatus(
          { environmentId: selectedThread.environmentId, cwd },
          { ...client.vcs, runChangeRequest: client.git.runStackedAction },
          options,
        );
        setPendingConnectionError(null);
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to refresh git status.";
        setPendingConnectionError(message);
        return null;
      }
    },
    [selectedThread, selectedThreadCwd, selectedThreadProject],
  );

  useEffect(() => {
    if (!selectedThread || !selectedThreadProject) {
      return;
    }

    void refreshSelectedThreadGitStatus({ quiet: true });
  }, [refreshSelectedThreadGitStatus, selectedThread, selectedThreadProject]);

  const runSelectedThreadGitMutation = useCallback(
    async <T>(
      operation: (input: {
        readonly thread: EnvironmentScopedThreadShell;
        readonly project: EnvironmentScopedProjectShell;
        readonly cwd: string;
      }) => Promise<T>,
    ): Promise<T | null> => {
      if (!selectedThread || !selectedThreadProject) {
        return null;
      }

      const cwd = selectedThreadCwd;
      if (!cwd) {
        return null;
      }

      try {
        setPendingConnectionError(null);
        return await operation({
          thread: selectedThread,
          project: selectedThreadProject,
          cwd,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Git action failed.";
        setPendingConnectionError(message);
        showGitActionResult({ type: "error", title: "Git action failed", description: message });
        return null;
      }
    },
    [selectedThread, selectedThreadCwd, selectedThreadProject],
  );

  const refreshSelectedThreadBranches = useCallback(async (): Promise<ReadonlyArray<VcsRef>> => {
    if (!selectedThread || !selectedThreadProject || !selectedThreadGitRootCwd) {
      return [];
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      return [];
    }

    try {
      const result = await vcsRefManager.load(
        { environmentId: selectedThread.environmentId, cwd: selectedThreadGitRootCwd, query: null },
        client.vcs,
        { limit: 100 },
      );
      return dedupeRemoteBranchesWithLocalMatches(result?.refs ?? []).filter(
        (branch) => !branch.isRemote,
      );
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to load branches.",
      );
      return [];
    }
  }, [selectedThread, selectedThreadGitRootCwd, selectedThreadProject]);

  const syncSelectedThreadBranchState = useCallback(
    async (input: {
      readonly thread: EnvironmentScopedThreadShell;
      readonly cwd: string;
      readonly branchRootCwd?: string | null;
      readonly nextThreadState?: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      };
    }) => {
      if (input.nextThreadState) {
        await updateThreadGitContext(input.thread, input.nextThreadState);
      }

      const branchRootCwd = input.branchRootCwd ?? selectedThreadProject?.workspaceRoot ?? null;
      if (branchRootCwd) {
        vcsRefManager.invalidate({
          environmentId: input.thread.environmentId,
          cwd: branchRootCwd,
          query: null,
        });
        await refreshSelectedThreadBranches();
      }

      await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
    },
    [
      refreshSelectedThreadBranches,
      refreshSelectedThreadGitStatus,
      selectedThreadProject?.workspaceRoot,
      updateThreadGitContext,
    ],
  );

  const onCheckoutSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
        const result = await vcsActionManager.switchRef(
          { environmentId: thread.environmentId, cwd },
          { refName: branch },
        );
        await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: {
            branch: result?.refName ?? thread.branch,
            worktreePath: selectedThreadWorktreePath,
          },
        });
      });
    },
    [runSelectedThreadGitMutation, selectedThreadWorktreePath, syncSelectedThreadBranchState],
  );

  const onCreateSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
        const result = await vcsActionManager.createRef(
          { environmentId: thread.environmentId, cwd },
          {
            refName: branch,
            switchRef: true,
          },
        );
        await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: {
            branch: result?.refName ?? thread.branch,
            worktreePath: selectedThreadWorktreePath,
          },
        });
      });
    },
    [runSelectedThreadGitMutation, selectedThreadWorktreePath, syncSelectedThreadBranchState],
  );

  const onCreateSelectedThreadWorktree = useCallback(
    async (nextWorktree: { readonly baseBranch: string; readonly newBranch: string }) => {
      await runSelectedThreadGitMutation(async ({ thread, project }) => {
        const result = await vcsActionManager.createWorktree(
          { environmentId: thread.environmentId, cwd: project.workspaceRoot },
          {
            refName: nextWorktree.baseBranch,
            newRefName: sanitizeFeatureBranchName(nextWorktree.newBranch),
            path: null,
          },
        );
        if (!result) {
          return;
        }

        await syncSelectedThreadBranchState({
          thread,
          cwd: result.worktree.path,
          branchRootCwd: project.workspaceRoot,
          nextThreadState: {
            branch: result.worktree.refName,
            worktreePath: result.worktree.path,
          },
        });
      });
    },
    [runSelectedThreadGitMutation, syncSelectedThreadBranchState],
  );

  const onPullSelectedThreadBranch = useCallback(async () => {
    await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
      const result = await vcsActionManager.pull({ environmentId: thread.environmentId, cwd });
      await refreshSelectedThreadGitStatus({ quiet: true, cwd });
      if (result) {
        showGitActionResult({
          type: "success",
          title:
            result.status === "skipped_up_to_date"
              ? "Already up to date"
              : `Pulled latest on ${result.refName}`,
        });
      }
    });
  }, [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation]);

  const onRunSelectedThreadGitAction = useCallback(
    async (input: GitActionRequestInput): Promise<GitRunStackedActionResult | null> => {
      return await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
        const result = await vcsActionManager.runChangeRequest(
          { environmentId: thread.environmentId, cwd },
          {
            actionId: uuidv4(),
            action: input.action,
            ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
            ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
            ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          },
          {
            gitStatus: vcsStatusManager.getSnapshot({
              environmentId: thread.environmentId,
              cwd,
            }).data,
          },
        );
        if (!result) {
          return null;
        }

        showGitActionResult({
          type: "success",
          title: result.toast.title,
          description: result.toast.description,
          prUrl: result.toast.cta.kind === "open_pr" ? result.toast.cta.url : undefined,
        });

        if (result.branch.status === "created" && result.branch.name) {
          await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.branch.name,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          return result;
        }

        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        return result;
      });
    },
    [
      refreshSelectedThreadGitStatus,
      runSelectedThreadGitMutation,
      selectedThreadWorktreePath,
      syncSelectedThreadBranchState,
    ],
  );

  return {
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
  };
}
