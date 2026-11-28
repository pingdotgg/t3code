import { useNavigation } from "@react-navigation/native";
import { useAtomMount } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";

import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  createVcsStatusRevalidationAtomFamily,
  type GitActionRequestInput,
  pushRemoteChoicesFor,
  type RunVcsStackedActionInput,
  type VcsActionOperation,
  type VcsRef,
} from "@t3tools/client-runtime/state/vcs";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import { AsyncResult } from "effect/reactivity";

import { useBranches } from "./queries";
import { threadEnvironment } from "./threads";
import { vcsActionManager, vcsEnvironment } from "./vcs";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import {
  environmentConnectedAtom,
  setPendingConnectionError,
} from "./use-remote-environment-registry";
import { useAtomCommand } from "./use-atom-command";
import type { GitRepositoryTarget } from "./thread-git-target";
import {
  noteRepositoryGitAction,
  showGitActionResult,
  type GitActionResultNotification,
} from "./use-vcs-action-state";
import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";

function refreshFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return errorDisplayMessage(error, m) ?? m(msg("Failed to refresh git status."));
}

// Selecting a thread or reconnecting its environment refreshes the checkout's
// status once, shared by every sheet that shows it.
const selectedThreadStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  connected: environmentConnectedAtom,
  onRefreshed: (result) =>
    setPendingConnectionError(
      AsyncResult.isFailure(result) ? refreshFailureMessage(result.cause) : null,
    ),
});

/**
 * Git actions for the selected thread's own folder, or for `repository` when given. A repository
 * keeps the thread as the owner of the work but never writes its branch back onto the thread.
 */
export function useSelectedThreadGitActions(repository?: GitRepositoryTarget) {
  const navigation = useNavigation();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setPushRemote = useAtomCommand(vcsEnvironment.setPushRemote, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const threadRef = selectedThread
    ? { environmentId: selectedThread.environmentId, threadId: selectedThread.id }
    : null;
  const reportGitActionResult = (result: GitActionResultNotification) => {
    if (threadRef !== null) showGitActionResult({ ...result, threadRef });
  };
  const canWriteSourceControl = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canChangeThreadBranch = canWriteSourceControl && canOperateThread;
  // Only the thread's own folder has a branch the thread records, which takes operating the thread.
  const followsThreadBranch = repository === undefined;
  const canCreateFeatureBranch = followsThreadBranch
    ? canChangeThreadBranch
    : canWriteSourceControl;
  const threadWorktree = useSelectedThreadWorktree();
  const { selectedThreadWorktreePath } = threadWorktree;
  const selectedThreadCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;
  const runStackedAction = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    { reportFailure: false },
  );

  const selectedThreadGitRootCwd = repository?.cwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const branchTarget = {
    environmentId: selectedThread?.environmentId ?? null,
    cwd: selectedThreadGitRootCwd,
    query: null,
  };
  const branchState = useBranches(branchTarget);
  const updateThreadGitContext = async (
    thread: NonNullable<typeof selectedThread>,
    nextState: {
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    },
  ) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure<never, EnvironmentAuthorizationError>(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: m(msg("This connection cannot update the thread's branch.")),
          }),
        ),
      );
    }
    return updateThreadMetadata({
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
        ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
      },
    });
  };

  const refreshSelectedThreadGitStatus = async (options?: {
    readonly quiet?: boolean;
    readonly cwd?: string | null;
  }) => {
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
            label: m(msg("Refreshing source control status")),
          },
          execute,
        );
    if (AsyncResult.isFailure(result)) {
      setPendingConnectionError(refreshFailureMessage(result.cause));
      return null;
    }
    setPendingConnectionError(null);
    return result.value;
  };

  useAtomMount(
    selectedThreadStatusRevalidation(
      selectedThread && selectedThreadProject && selectedThreadCwd
        ? { environmentId: selectedThread.environmentId, cwd: selectedThreadCwd }
        : null,
    ),
  );

  const runSelectedThreadGitMutation = async <T, E>(
    operation: VcsActionOperation,
    label: string,
    execute: (input: {
      readonly thread: EnvironmentThreadShell;
      readonly project: EnvironmentProject;
      readonly cwd: string;
    }) => Promise<AtomCommandResult<T, E>>,
    options?: { readonly managedExternally?: boolean; readonly changesThreadBranch?: boolean },
  ): Promise<T | null> => {
    if (
      !selectedThread ||
      !selectedThreadProject ||
      !selectedThreadCwd ||
      !readEnvironmentScope(selectedThread.environmentId, AuthSourceControlWriteScope) ||
      (options?.changesThreadBranch === true &&
        followsThreadBranch &&
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope))
    ) {
      return null;
    }

    const target = {
      environmentId: selectedThread.environmentId,
      cwd: selectedThreadCwd,
    };
    setPendingConnectionError(null);
    if (repository !== undefined) {
      noteRepositoryGitAction({
        threadRef: { environmentId: selectedThread.environmentId, threadId: selectedThread.id },
        cwd: selectedThreadCwd,
      });
    }
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
      const message = errorDisplayMessage(error, m) ?? m(msg("Git action failed."));
      setPendingConnectionError(message);
      reportGitActionResult({
        type: "error",
        title: m(msg("Git action failed")),
        description: message,
      });
      return null;
    }
    return result.value;
  };

  const refreshSelectedThreadBranches = async (): Promise<ReadonlyArray<VcsRef> | null> => {
    if (branchTarget.environmentId === null || branchTarget.cwd === null) return null;
    const result = await readRefs({
      environmentId: branchTarget.environmentId,
      input: { cwd: branchTarget.cwd, limit: 100, refresh: true },
    });
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      const message = errorDisplayMessage(error, m) ?? m(msg("Failed to refresh branches."));
      setPendingConnectionError(message);
      reportGitActionResult({
        type: "error",
        title: m(msg("Git action failed")),
        description: message,
      });
      return null;
    }
    setPendingConnectionError(null);
    return dedupeRemoteBranchesWithLocalMatches(result.value.refs).filter(
      (branch) => !branch.isRemote,
    );
  };

  const syncSelectedThreadBranchState = async (input: {
    readonly thread: EnvironmentThreadShell;
    readonly cwd: string;
    readonly nextThreadState?: {
      readonly branch?: string | null;
      readonly worktreePath?: string | null;
    };
  }): Promise<AtomCommandResult<void, unknown>> => {
    // Git already changed; refresh even if metadata updates fail so the sheet shows the current branch.
    const updateResult =
      input.nextThreadState && followsThreadBranch
        ? await updateThreadGitContext(input.thread, input.nextThreadState)
        : AsyncResult.success(undefined);
    branchState.refresh();
    await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
    return AsyncResult.isFailure(updateResult)
      ? AsyncResult.failure(updateResult.cause)
      : AsyncResult.success(undefined);
  };

  const onCheckoutSelectedThreadBranch = async (branch: string) => {
    return runSelectedThreadGitMutation(
      "switch_ref",
      m(msg("Switching branch")),
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
      { changesThreadBranch: true },
    );
  };

  const onCreateSelectedThreadBranch = async (branch: string) => {
    return runSelectedThreadGitMutation(
      "create_ref",
      m(msg("Creating branch")),
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
      { changesThreadBranch: true },
    );
  };

  const onCreateSelectedThreadWorktree = async (nextWorktree: {
    readonly baseBranch: string;
    readonly newBranch: string;
  }) => {
    // A worktree moves the thread, which a repository beside it never does.
    if (!followsThreadBranch) return null;
    return runSelectedThreadGitMutation(
      "create_worktree",
      m(msg("Creating worktree")),
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
      { changesThreadBranch: true },
    );
  };

  const onPullSelectedThreadBranch = async () => {
    await runSelectedThreadGitMutation(
      "pull",
      m(msg("Pulling latest changes")),
      async ({ thread, cwd }) => {
        const result = await pull({
          environmentId: thread.environmentId,
          input: { cwd },
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        reportGitActionResult({
          type: "success",
          title:
            result.value.status === "skipped_up_to_date"
              ? m(msg("Already up to date"))
              : m(msg("Pulled latest on {branch}", { branch: result.value.refName })),
        });
        return result;
      },
    );
  };

  const selectedThreadGitStatus = () =>
    selectedThread && selectedThreadCwd
      ? AsyncResult.getOrElse(
          appAtomRegistry.get(
            vcsEnvironment.status({
              environmentId: selectedThread.environmentId,
              input: { cwd: selectedThreadCwd },
            }),
          ),
          () => null,
        )
      : null;

  const onSetSelectedThreadPushRemote = async (remoteName: string) => {
    const refName = selectedThreadGitStatus()?.refName;
    if (!refName) return null;
    return runSelectedThreadGitMutation(
      "switch_ref",
      m(msg("Changing push remote")),
      async ({ thread, cwd }) => {
        const result = await setPushRemote({
          environmentId: thread.environmentId,
          input: { cwd, refName, remoteName },
        });
        if (AsyncResult.isSuccess(result)) {
          await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        }
        return result;
      },
    );
  };

  const onRunSelectedThreadGitAction = async (
    input: GitActionRequestInput & Pick<RunVcsStackedActionInput, "onProgress">,
  ): Promise<GitRunStackedActionResult | null> => {
    // Every entry point lands here, after any default-branch confirmation.
    const pushRemoteChoices = pushRemoteChoicesFor(input, selectedThreadGitStatus());
    if (pushRemoteChoices && selectedThread) {
      navigation.navigate("GitRemote", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        action: input.action,
        ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
        ...(input.featureBranch ? { featureBranch: "true" } : {}),
        ...(input.filePaths?.length ? { filePaths: JSON.stringify(input.filePaths) } : {}),
      });
      return null;
    }
    const actionId = uuidv4();
    return await runSelectedThreadGitMutation(
      "run_change_request",
      m(msg("Running source control action")),
      async ({ thread, cwd }) => {
        const result = await runStackedAction({
          actionId,
          action: input.action,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
          ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          ...(input.pushRemote ? { pushRemote: input.pushRemote } : {}),
          threadId: thread.id,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        });
        if (AsyncResult.isFailure(result)) {
          return result;
        }

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
        reportGitActionResult({
          type: "success",
          title: result.value.toast.title,
          description: result.value.toast.description,
          prUrl: result.value.toast.cta.kind === "open_pr" ? result.value.toast.cta.url : undefined,
        });
        return result;
      },
      { managedExternally: true, changesThreadBranch: input.featureBranch === true },
    );
  };

  return {
    canWriteSourceControl,
    canChangeThreadBranch,
    canCreateFeatureBranch,
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onPullSelectedThreadBranch,
    onSetSelectedThreadPushRemote,
    onRunSelectedThreadGitAction,
  };
}
