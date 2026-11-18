import { useAtomMount } from "@effect/atom-react";
import { useState } from "react";
import * as Dialog from "../components/ui/Dialog";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";

import { EnvironmentProject, EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  createVcsStatusRevalidationAtomFamily,
  type GitActionRequestInput,
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
import { useVcsTerminology, vcsActionManager, vcsEnvironment } from "./vcs";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope, useEnvironmentScope } from "./session";
import {
  environmentConnectedAtom,
  setPendingConnectionError,
} from "./use-remote-environment-registry";
import { useAtomCommand } from "./use-atom-command";
import { showGitActionResult } from "./use-vcs-action-state";
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

export function useSelectedThreadGitActions() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const readRefs = useAtomCommand(vcsEnvironment.readRefs, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, { reportFailure: false });
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const canWriteSourceControl = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthSourceControlWriteScope,
  );
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canChangeThreadBranch = canWriteSourceControl && canOperateThread;
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const vcsTerminology = useVcsTerminology(
    selectedThread?.environmentId ?? null,
    selectedThreadCwd,
  );
  const [pendingWorkspaceMetadataCleanup, setPendingWorkspaceMetadataCleanup] = useState<
    string | null
  >(null);
  const runStackedAction = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    { reportFailure: false },
  );

  const selectedThreadGitRootCwd = selectedThreadProject?.workspaceRoot ?? null;
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
        !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope))
    ) {
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
      const message = errorDisplayMessage(error, m) ?? m(msg("Git action failed."));
      setPendingConnectionError(message);
      showGitActionResult({
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
      showGitActionResult({
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
    const updateResult = input.nextThreadState
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
      vcsTerminology.systemName === "Git"
        ? m(msg("Switching branch"))
        : `Switching ${vcsTerminology.refNoun}`,
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
      vcsTerminology.systemName === "Git"
        ? m(msg("Creating branch"))
        : `Creating ${vcsTerminology.refNoun}`,
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
    return runSelectedThreadGitMutation(
      "create_worktree",
      vcsTerminology.systemName === "Git"
        ? m(msg("Creating worktree"))
        : `Creating ${vcsTerminology.workspaceNoun}`,
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

  const onRemoveSelectedThreadWorkspace = async (): Promise<boolean> => {
    const thread = selectedThread;
    const project = selectedThreadProject;
    const worktreePath = selectedThreadWorktreePath;
    if (!thread || !project || !worktreePath || !canChangeThreadBranch) return false;
    if (pendingWorkspaceMetadataCleanup !== worktreePath) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Dialog.alert(
          m(msg("Remove this {workspaceNoun}?", { workspaceNoun: vcsTerminology.workspaceNoun })),
          m(
            msg("{worktreePath}\n\nThe thread stays; only the {workspaceNoun} is deleted.", {
              worktreePath,
              workspaceNoun: vcsTerminology.workspaceNoun,
            }),
          ),
          [
            { text: m(msg("Cancel")), style: "cancel", onPress: () => resolve(false) },
            { text: m(msg("Remove")), style: "destructive", onPress: () => resolve(true) },
          ],
        );
      });
      if (!confirmed) return false;
      let result = await removeWorktree({
        environmentId: thread.environmentId,
        input: { cwd: project.workspaceRoot, path: worktreePath, force: false },
      });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "An error occurred.";
        if (message.includes("uncommitted or unbookmarked changes")) {
          const discard = await new Promise<boolean>((resolve) => {
            Dialog.alert(
              m(
                msg("Discard changes and remove {workspaceNoun}?", {
                  workspaceNoun: vcsTerminology.workspaceNoun,
                }),
              ),
              m(
                msg("Uncommitted or unbookmarked changes in {worktreePath} will be lost.", {
                  worktreePath,
                }),
              ),
              [
                { text: m(msg("Cancel")), style: "cancel", onPress: () => resolve(false) },
                {
                  text: m(msg("Discard and remove")),
                  style: "destructive",
                  onPress: () => resolve(true),
                },
              ],
            );
          });
          if (!discard) return false;
          result = await removeWorktree({
            environmentId: thread.environmentId,
            input: { cwd: project.workspaceRoot, path: worktreePath, force: true },
          });
        }
      }
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        showGitActionResult({
          type: "error",
          title: m(
            msg("Failed to remove {workspaceNoun}", {
              workspaceNoun: vcsTerminology.workspaceNoun,
            }),
          ),
          description: error instanceof Error ? error.message : m(msg("An error occurred.")),
        });
        return false;
      }
    }
    const syncResult = await syncSelectedThreadBranchState({
      thread,
      cwd: project.workspaceRoot,
      nextThreadState: { worktreePath: null },
    });
    if (AsyncResult.isFailure(syncResult)) {
      setPendingWorkspaceMetadataCleanup(worktreePath);
      const error = Cause.squash(syncResult.cause);
      showGitActionResult({
        type: "error",
        title: m(
          msg("{workspaceNounTitle} removed, but thread update failed", {
            workspaceNounTitle: vcsTerminology.workspaceNounTitle,
          }),
        ),
        description:
          error instanceof Error
            ? error.message
            : m(msg("Try clearing the thread workspace again.")),
      });
      return false;
    }
    setPendingWorkspaceMetadataCleanup(null);
    showGitActionResult({ type: "success", title: `${vcsTerminology.workspaceNounTitle} removed` });
    return true;
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
        showGitActionResult({
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

  const onRunSelectedThreadGitAction = async (
    input: GitActionRequestInput,
  ): Promise<GitRunStackedActionResult | null> => {
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
          threadId: thread.id,
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
        showGitActionResult({
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
    pendingWorkspaceMetadataCleanup,
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onRemoveSelectedThreadWorkspace,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
  };
}
