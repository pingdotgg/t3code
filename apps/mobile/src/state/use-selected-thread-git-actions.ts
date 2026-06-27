import { useCallback, useEffect, useMemo } from "react";

import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type GitActionRequestInput,
  type VcsActionOperation,
  type VcsRef,
} from "@t3tools/client-runtime/state/vcs";
import type { GitRunStackedActionResult } from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { useBranches } from "../state/queries";
import { threadEnvironment } from "../state/threads";
import { vcsActionManager, vcsEnvironment } from "../state/vcs";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { setPendingConnectionError } from "./use-remote-environment-registry";
import { useAtomCommand } from "./use-atom-command";
import { showGitActionResult } from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

export function useSelectedThreadGitActions() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const runStackedAction = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    { reportFailure: false },
  );

  const selectedThreadGitRootCwd = selectedThreadProject?.workspaceRoot ?? null;
  const branchTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadGitRootCwd,
      query: null,
    }),
    [selectedThread?.environmentId, selectedThreadGitRootCwd],
  );
  const branchState = useBranches(branchTarget);
  const updateThreadGitContext = useCallback(
    async (
      thread: NonNullable<typeof selectedThread>,
      nextState: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      },
    ) => {
      return updateThreadMetadata({
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
          ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
        },
      });
    },
    [updateThreadMetadata],
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

      const target = { environmentId: selectedThread.environmentId, cwd };
      const execute = () =>
        refreshStatus({
          environmentId: selectedThread.environmentId,
          input: { cwd },
        });
      const result = options?.quiet
        ? await execute()
        : await vcsActionManager.track(
            appAtomRegistry,
            target,
            {
              operation: "refresh_status",
              label: "Refreshing source control status",
            },
            execute,
          );
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "Failed to refresh git status.";
        setPendingConnectionError(message);
        return null;
      }
      setPendingConnectionError(null);
      return result.value;
    },
    [refreshStatus, selectedThread, selectedThreadCwd, selectedThreadProject],
  );

  useEffect(() => {
    if (!selectedThread || !selectedThreadProject) {
      return;
    }
    void refreshSelectedThreadGitStatus({ quiet: true });
  }, [refreshSelectedThreadGitStatus, selectedThread, selectedThreadProject]);

  const runSelectedThreadGitMutation = useCallback(
    async <T, E>(
      operation: VcsActionOperation,
      label: string,
      execute: (input: {
        readonly thread: EnvironmentThreadShell;
        readonly project: EnvironmentProject;
        readonly cwd: string;
      }) => Promise<AtomCommandResult<T, E>>,
      options?: { readonly managedExternally?: boolean },
    ): Promise<T | null> => {
      if (!selectedThread || !selectedThreadProject || !selectedThreadCwd) {
        return null;
      }

      const target = {
        environmentId: selectedThread.environmentId,
        cwd: selectedThreadCwd,
      };
      setPendingConnectionError(null);
      const run = () =>
        execute({
          thread: selectedThread,
          project: selectedThreadProject,
          cwd: selectedThreadCwd,
        });
      const result =
        options?.managedExternally === true
          ? await run()
          : await vcsActionManager.track(appAtomRegistry, target, { operation, label }, run);
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "Git action failed.";
        setPendingConnectionError(message);
        showGitActionResult({ type: "error", title: "Git action failed", description: message });
        return null;
      }
      return result.value;
    },
    [selectedThread, selectedThreadCwd, selectedThreadProject],
  );

  const refreshSelectedThreadBranches = useCallback(async (): Promise<ReadonlyArray<VcsRef>> => {
    branchState.refresh();
    return dedupeRemoteBranchesWithLocalMatches(branchState.data?.refs ?? []).filter(
      (branch) => !branch.isRemote,
    );
  }, [branchState]);

  const syncSelectedThreadBranchState = useCallback(
    async (input: {
      readonly thread: EnvironmentThreadShell;
      readonly cwd: string;
      readonly nextThreadState?: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      };
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (input.nextThreadState) {
        const updateResult = await updateThreadGitContext(input.thread, input.nextThreadState);
        if (AsyncResult.isFailure(updateResult)) {
          return AsyncResult.failure(updateResult.cause);
        }
      }
      branchState.refresh();
      await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
      return AsyncResult.success(undefined);
    },
    [branchState, refreshSelectedThreadGitStatus, updateThreadGitContext],
  );

  const onCheckoutSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(
        "switch_ref",
        "Switching branch",
        async ({ thread, cwd }) => {
          const result = await switchRef({
            environmentId: thread.environmentId,
            input: { cwd, refName: branch },
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.value.refName ?? thread.branch,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
        },
      );
    },
    [
      runSelectedThreadGitMutation,
      selectedThreadWorktreePath,
      syncSelectedThreadBranchState,
      switchRef,
    ],
  );

  const onCreateSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(
        "create_ref",
        "Creating branch",
        async ({ thread, cwd }) => {
          const result = await createRef({
            environmentId: thread.environmentId,
            input: { cwd, refName: branch, switchRef: true },
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.value.refName ?? thread.branch,
              worktreePath: selectedThreadWorktreePath,
            },
          });
          return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
        },
      );
    },
    [
      runSelectedThreadGitMutation,
      selectedThreadWorktreePath,
      syncSelectedThreadBranchState,
      createRef,
    ],
  );

  const onCreateSelectedThreadWorktree = useCallback(
    async (nextWorktree: { readonly baseBranch: string; readonly newBranch: string }) => {
      await runSelectedThreadGitMutation(
        "create_worktree",
        "Creating worktree",
        async ({ thread, project }) => {
          const result = await createWorktree({
            environmentId: thread.environmentId,
            input: {
              cwd: project.workspaceRoot,
              refName: nextWorktree.baseBranch,
              newRefName: sanitizeFeatureBranchName(nextWorktree.newBranch),
              path: null,
            },
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }
          const syncResult = await syncSelectedThreadBranchState({
            thread,
            cwd: result.value.worktree.path,
            nextThreadState: {
              branch: result.value.worktree.refName,
              worktreePath: result.value.worktree.path,
            },
          });
          return AsyncResult.isFailure(syncResult) ? AsyncResult.failure(syncResult.cause) : result;
        },
      );
    },
    [createWorktree, runSelectedThreadGitMutation, syncSelectedThreadBranchState],
  );

  const onPullSelectedThreadBranch = useCallback(async () => {
    await runSelectedThreadGitMutation(
      "pull",
      "Pulling latest changes",
      async ({ thread, cwd }) => {
        const result = await pull({
          environmentId: thread.environmentId,
          input: { cwd },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        showGitActionResult({
          type: "success",
          title:
            result.value.status === "skipped_up_to_date"
              ? "Already up to date"
              : `Pulled latest on ${result.value.refName}`,
        });
        return result;
      },
    );
  }, [pull, refreshSelectedThreadGitStatus, runSelectedThreadGitMutation]);

  const onRunSelectedThreadGitAction = useCallback(
    async (input: GitActionRequestInput): Promise<GitRunStackedActionResult | null> => {
      const actionId = uuidv4();
      return await runSelectedThreadGitMutation(
        "run_change_request",
        "Running source control action",
        async ({ thread, cwd }) => {
          const result = await runStackedAction({
            actionId,
            action: input.action,
            ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
            ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
            ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          });
          if (AsyncResult.isFailure(result)) {
            return result;
          }

          showGitActionResult({
            type: "success",
            title: result.value.toast.title,
            description: result.value.toast.description,
            prUrl:
              result.value.toast.cta.kind === "open_pr" ? result.value.toast.cta.url : undefined,
          });

          if (result.value.branch.status === "created" && result.value.branch.name) {
            const syncResult = await syncSelectedThreadBranchState({
              thread,
              cwd,
              nextThreadState: {
                branch: result.value.branch.name,
                worktreePath: selectedThreadWorktreePath,
              },
            });
            if (AsyncResult.isFailure(syncResult)) {
              return AsyncResult.failure(syncResult.cause);
            }
          } else {
            await refreshSelectedThreadGitStatus({ quiet: true, cwd });
          }
          return result;
        },
        { managedExternally: true },
      );
    },
    [
      runStackedAction,
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
