import type {
  ContextMenuItem,
  ScopedThreadRef,
  VcsPanelBranchDetails,
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { ensureLocalApi, readLocalApi } from "~/localApi";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { useRightPanelStore } from "~/rightPanelStore";
import { serverEnvironment } from "~/state/server";
import {
  isSourceControlPanelCommandInterrupted,
  useSourceControlPanelApi,
} from "~/state/sourceControlPanel";
import { resolvePathLinkTarget } from "~/terminal-links";

import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import {
  beginPanelAction,
  beginPanelFileDiffLoad,
  branchHasUpstream,
  branchIsCheckedOut,
  branchOperationCwd,
  branchSyncCounts,
  branchSyncState,
  confirmSourceControlPanelMutation,
  drainPanelRefreshQueue,
  namedBranchOperationCwd,
  panelActionError,
  resolveBranchSyncSnapshot,
  runPanelActionAndReconcile,
  type PanelChangedFile,
  stashIdentityKey,
} from "./SourceControlPanel.logic";
import {
  COMMIT_PAGE_SIZE,
  MIN_SECTION_WEIGHT,
  SECTION_TITLES,
  applyWorkingTreeFileEnrichment,
  commitUndoActionKey,
  enrichmentFileKey,
  errorMessage,
  expandedStashesForSnapshot,
  fileBasename,
  isActionForced,
  localOnlyBranches,
  operationPathsForFile,
  shouldEnrichWorkingTreeFile,
  shouldFetchBeforePull,
  sumFiles,
  treeKey,
  uniquePaths,
  changeSetAttention,
  contextMenuSeparator,
  type FileDiffSource,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";
import { InlineFileDiff } from "./SourceControlPanelRows";

export function useSourceControlPanelActions(
  state: SourceControlPanelState,
  refresh: (mode?: "full" | "working-tree") => Promise<void>,
) {
  const runningActionKeysRef = useRef(new Set<string>());
  const [createBranchCommitTarget, setCreateBranchCommitTarget] =
    useState<VcsPanelCommitSummary | null>(null);
  const [createBranchName, setCreateBranchName] = useState("");
  const {
    api,
    changedFiles,
    cwd,
    dialogStashMessage,
    divergedSyncBranch,
    expandedFileDiffs,
    fileDiffKey,
    fileDiffsByKey,
    filePanelThreadRef,
    initialFetchCwdRef,
    loadFileDiff,
    onThreadRefChange,
    openInPreferredEditor,
    remoteName,
    resolvedTheme,
    runningActions,
    selectedChangedFiles,
    selectedChangePathList,
    setAddRemoteOpen,
    setCommitDialogOpen,
    setDialogCommitMessage,
    setDialogStashMessage,
    setDivergedSyncBranch,
    setError,
    setExpandedFileDiffs,
    setMutationError,
    setPublishRemoteTarget,
    setRemoteUrl,
    setRunningActions,
    setStashDialogTarget,
    snapshot,
    sourceControlAllRemotesFetchIntervalMs,
    stashDialogTarget,
    vcsStatus,
    worktreePath,
  } = state;
  const runAction = useCallback(
    async (actionKey: string, action: () => Promise<void>) => {
      if (!beginPanelAction(runningActionKeysRef.current, actionKey)) return;
      setRunningActions((current) => new Set(current).add(actionKey));
      setError(null);
      setMutationError(null);
      let result: Awaited<ReturnType<typeof runPanelActionAndReconcile>> | null = null;
      try {
        result = await runPanelActionAndReconcile({
          action,
          reconcile: async () => {
            vcsStatus.refresh();
            await refresh();
          },
        });
        if (result.status === "failure" && !isSourceControlPanelCommandInterrupted(result.error)) {
          setMutationError(errorMessage(result.error));
        }
      } catch (reconcileError) {
        const nextError = panelActionError(result, reconcileError);
        if (isSourceControlPanelCommandInterrupted(nextError)) return;
        setMutationError(errorMessage(nextError));
      } finally {
        runningActionKeysRef.current.delete(actionKey);
        setRunningActions((current) => {
          const next = new Set(current);
          next.delete(actionKey);
          return next;
        });
      }
    },
    [refresh, setMutationError, vcsStatus.refresh],
  );

  const openFilePanel = useCallback(
    (path: string, targetCwd = cwd) => {
      if (!filePanelThreadRef) return;
      useRightPanelStore
        .getState()
        .openFile(filePanelThreadRef, path, undefined, targetCwd === cwd ? undefined : targetCwd);
    },
    [cwd, filePanelThreadRef],
  );

  const openInVsCode = useCallback(
    async (path: string, targetCwd = cwd) => {
      const result = await openInPreferredEditor(resolvePathLinkTarget(path, targetCwd));
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const nextError = squashAtomCommandFailure(result);
      setError(nextError instanceof Error ? nextError.message : "Unable to open file.");
    },
    [cwd, openInPreferredEditor],
  );

  const confirm = useCallback(async (message: string) => {
    return confirmSourceControlPanelMutation(ensureLocalApi().dialogs.confirm, message);
  }, []);

  const copyText = useCallback((value: string, missingMessage = "Nothing to copy.") => {
    if (!value) {
      setError(missingMessage);
      return;
    }
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      setError("Clipboard API unavailable.");
      return;
    }
    setError(null);
    void navigator.clipboard
      .writeText(value)
      .catch((nextError) => setError(errorMessage(nextError)));
  }, []);

  const openContextMenu = useCallback(
    <T extends string>(
      event: ReactMouseEvent,
      items: readonly ContextMenuItem<T>[],
      handlers: Partial<Record<T, () => Promise<void> | void>>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const localApi = readLocalApi();
        if (!localApi) return;
        const clicked = await localApi.contextMenu.show(items, {
          x: event.clientX,
          y: event.clientY,
        });
        if (!clicked) return;
        await handlers[clicked]?.();
      })();
    },
    [],
  );

  const openFileChangeContextMenu = useCallback(
    (event: ReactMouseEvent, file: VcsPanelFileChange) => {
      openContextMenu(
        event,
        [
          ...(filePanelThreadRef ? ([{ id: "open-file", label: "Open file" }] as const) : []),
          { id: "open-vscode", label: "Open in VS Code" },
          contextMenuSeparator("copy-separator"),
          { id: "copy-filename", label: "Copy filename", icon: "copy" },
          { id: "copy-full-path", label: "Copy full path to file", icon: "copy" },
        ],
        {
          ...(filePanelThreadRef ? { "open-file": () => openFilePanel(file.path) } : {}),
          "open-vscode": () => openInVsCode(file.path),
          "copy-filename": () => copyText(fileBasename(file.path)),
          "copy-full-path": () => copyText(resolvePathLinkTarget(file.path, cwd)),
        },
      );
    },
    [copyText, cwd, filePanelThreadRef, openContextMenu, openFilePanel, openInVsCode],
  );

  const toggleFileDiff = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource, targetCwd = cwd) => {
      const key = fileDiffKey(file, source, targetCwd);
      const expanding = !expandedFileDiffs.has(key);
      setExpandedFileDiffs((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
          return next;
        }
        next.add(key);
        return next;
      });
      if (!api || !expanding) return;
      const existingState = fileDiffsByKey.get(key);
      if (source.kind !== "working-tree" && existingState?.status === "loaded") return;
      loadFileDiff(file, source, targetCwd);
    },
    [api, cwd, expandedFileDiffs, fileDiffKey, fileDiffsByKey, loadFileDiff],
  );

  const renderFileDiff = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource, targetCwd = cwd) => {
      const state = fileDiffsByKey.get(fileDiffKey(file, source, targetCwd));
      if (!state || state.status === "loading") {
        return <div className="px-2 py-1 text-xs text-muted-foreground">Loading diff...</div>;
      }
      if (state.status === "error") {
        return <div className="px-2 py-1 text-xs text-destructive-foreground">{state.message}</div>;
      }
      return <InlineFileDiff patch={state.patch} resolvedTheme={resolvedTheme} />;
    },
    [cwd, fileDiffKey, fileDiffsByKey, resolvedTheme],
  );

  const fileDiffListProps = useCallback(
    (sourceForFile: (file: VcsPanelFileChange) => FileDiffSource, targetCwd = cwd) => ({
      getFileKey: (file: VcsPanelFileChange) => fileDiffKey(file, sourceForFile(file), targetCwd),
      isFileExpanded: (file: VcsPanelFileChange) =>
        expandedFileDiffs.has(fileDiffKey(file, sourceForFile(file), targetCwd)),
      onFileToggle: (file: VcsPanelFileChange) =>
        toggleFileDiff(file, sourceForFile(file), targetCwd),
      renderExpandedFile: (file: VcsPanelFileChange) =>
        renderFileDiff(file, sourceForFile(file), targetCwd),
      ...(filePanelThreadRef
        ? { onOpenFile: (file: VcsPanelFileChange) => openFilePanel(file.path, targetCwd) }
        : {}),
      onOpenInVsCode: (file: VcsPanelFileChange) => void openInVsCode(file.path, targetCwd),
    }),
    [
      cwd,
      expandedFileDiffs,
      filePanelThreadRef,
      fileDiffKey,
      openFilePanel,
      openInVsCode,
      renderFileDiff,
      toggleFileDiff,
    ],
  );

  const switchRef = useCallback(
    (refName: string) =>
      runAction(`branch-switch:${refName}`, async () => {
        if (!api) return;
        const result = await api.vcs.switchRef({ cwd, refName });
        await onThreadRefChange?.({ branch: result.refName, worktreePath });
      }),
    [api, cwd, onThreadRefChange, runAction, worktreePath],
  );

  const deleteBranch = useCallback(
    (branch: VcsRef, force: boolean) =>
      void (async () => {
        const branchLabel = branch.isRemote
          ? `remote branch ${branch.name}`
          : `branch ${branch.name}`;
        if (!(await confirm(`Delete ${branchLabel}?`))) return;
        await runAction(
          `branch-delete:${branch.name}`,
          () => api?.vcs.deleteBranch({ cwd, branchName: branch.name, force }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const undoCommit = useCallback(
    (branchName: string, commit?: VcsPanelCommitSummary) =>
      void (async () => {
        const actionKey = commitUndoActionKey(branchName, commit?.sha);
        const localBranches = snapshot?.localBranches ?? [];
        const branch = localBranches.find((candidate) => candidate.name === branchName);
        const targetCwd = namedBranchOperationCwd(localBranches, branchName, cwd);
        const confirmed = commit
          ? await confirm(
              `Undo ${commit.shortSha} and any newer commits on ${branchName}?${
                branchIsCheckedOut(branch)
                  ? branch?.current
                    ? " Changes stay in the working tree."
                    : " Changes stay in that branch's worktree."
                  : " This moves the branch back to that commit's parent."
              }`,
            )
          : await confirm(`Undo latest commit on ${branchName}?`);
        if (!confirmed) return;
        await runAction(
          actionKey,
          () =>
            api?.vcs.undoLatestCommit({
              cwd: targetCwd,
              branchName,
              ...(commit ? { sha: commit.sha } : {}),
            }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction, snapshot?.localBranches],
  );

  const mergeBranchIntoCurrent = useCallback(
    (branchName: string) =>
      void (async () => {
        if (!(await confirm(`Merge ${branchName} into the current branch?`))) return;
        await runAction(
          `branch-merge:${branchName}`,
          () => api?.vcs.mergeBranchIntoCurrent({ cwd, refName: branchName }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const rebaseCurrentOnto = useCallback(
    (refName: string) =>
      void (async () => {
        if (!(await confirm(`Rebase the current branch onto ${refName}?`))) return;
        await runAction(
          `rebase-current:${refName}`,
          () => api?.vcs.rebaseCurrentOnto({ cwd, refName }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const revertCommit = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        if (!(await confirm(`Revert commit ${commit.shortSha}?`))) return;
        await runAction(
          `commit-revert:${commit.sha}`,
          () => api?.vcs.revertCommit({ cwd, sha: commit.sha }) ?? Promise.resolve(),
        );
      })(),
    [api, confirm, cwd, runAction],
  );

  const checkoutCommitDetached = useCallback(
    (commit: VcsPanelCommitSummary) =>
      void (async () => {
        if (!(await confirm(`Checkout ${commit.shortSha} as detached HEAD?`))) return;
        await runAction(`commit-checkout:${commit.sha}`, async () => {
          if (!api) return;
          const result = await api.vcs.checkoutCommit({ cwd, sha: commit.sha });
          await onThreadRefChange?.({ branch: result.refName, worktreePath });
        });
      })(),
    [api, confirm, cwd, onThreadRefChange, runAction, worktreePath],
  );

  const createBranchFromCommit = useCallback((commit: VcsPanelCommitSummary) => {
    setCreateBranchName("");
    setCreateBranchCommitTarget(commit);
  }, []);

  const runCreateBranchFromCommit = useCallback(async () => {
    const target = createBranchCommitTarget;
    const branchName = createBranchName.trim();
    if (!target || !branchName) return;
    await runAction(`commit-create-branch:${target.sha}`, async () => {
      await api?.vcs.createBranchFromCommit({
        cwd,
        sha: target.sha,
        branchName,
      });
      setCreateBranchCommitTarget(null);
      setCreateBranchName("");
    });
  }, [api, createBranchCommitTarget, createBranchName, cwd, runAction]);

  const closeCreateBranchDialog = useCallback(() => {
    setCreateBranchCommitTarget(null);
    setCreateBranchName("");
  }, []);

  const publishBranch = useCallback(
    (branch: VcsRef, remoteName?: string, force = false) =>
      runAction(`branch-sync:${branch.name}`, async () => {
        await api?.vcs.pushBranch({
          cwd: branchOperationCwd(branch, cwd),
          branchName: branch.name,
          remoteName,
          force,
        });
      }),
    [api, cwd, runAction],
  );

  const publishBranchWithRemoteChoice = useCallback(
    (branch: VcsRef, force = false) => {
      if (!snapshot || branchHasUpstream(branch, snapshot)) {
        void publishBranch(branch, undefined, force);
        return;
      }
      if (snapshot.remotes.length > 1) {
        setPublishRemoteTarget({ branch, force });
        return;
      }
      void publishBranch(branch, snapshot.remotes[0]?.name, force);
    },
    [publishBranch, snapshot],
  );

  const runBranchSync = useCallback(
    (
      branch: VcsRef,
      {
        fetchFirst = false,
        force = false,
      }: {
        readonly fetchFirst?: boolean;
        readonly force?: boolean;
      } = {},
    ) => {
      if (!snapshot) return;
      const state = branchSyncState(branch, snapshot);
      if (state === "diverged") {
        setDivergedSyncBranch(branch);
        return;
      }
      if (state === "publish") {
        publishBranchWithRemoteChoice(branch, force);
        return;
      }
      if (!branch.current) {
        const actionKey =
          state === "fetch" ? `branch-fetch:${branch.name}` : `branch-sync:${branch.name}`;
        void runAction(actionKey, async () => {
          if (!api) return;
          const targetCwd = branchOperationCwd(branch, cwd);
          if (state === "push") {
            await api.vcs.pushBranch({ cwd: targetCwd, branchName: branch.name, force });
            return;
          }
          if (state === "pull") {
            await api.vcs.pullBranch({
              cwd: targetCwd,
              branchName: branch.name,
              force,
            });
            return;
          }
          await api.vcs.fetchBranch({ cwd: targetCwd, branchName: branch.name });
        });
        return;
      }
      void runAction(`branch-sync:${branch.name}`, async () => {
        if (!api) return;
        const targetCwd = branchOperationCwd(branch, cwd);
        const fetch = () => api.vcs.fetchBranch({ cwd: targetCwd, branchName: branch.name });
        const syncSnapshot = await resolveBranchSyncSnapshot({
          snapshot,
          fetchFirst,
          fetch,
          refreshSnapshot: () => api.vcs.panelSnapshot({ cwd: targetCwd, refresh: "full" }),
        });
        const syncState = branchSyncState(branch, syncSnapshot);
        if (syncState === "diverged") {
          setDivergedSyncBranch(branch);
          return;
        }
        const { aheadCount, behindCount } = branchSyncCounts(branch, syncSnapshot);
        if (aheadCount > 0) {
          await api.vcs.pushBranch({ cwd: targetCwd, branchName: branch.name, force });
          return;
        }
        if (behindCount > 0) {
          await api.vcs.pullBranch({
            cwd: targetCwd,
            branchName: branch.name,
            force,
          });
          return;
        }
        if (!fetchFirst) {
          await fetch();
        }
      });
    },
    [api, cwd, publishBranchWithRemoteChoice, runAction, snapshot],
  );

  const syncBranch = useCallback(
    (branch: VcsRef, event: ReactMouseEvent<HTMLButtonElement>) =>
      runBranchSync(branch, {
        fetchFirst: shouldFetchBeforePull(event),
        force: isActionForced(event),
      }),
    [runBranchSync],
  );

  const runDivergedSync = useCallback(
    (mode: "force-pull" | "merge" | "force-push") => {
      const branch = divergedSyncBranch;
      setDivergedSyncBranch(null);
      if (!branch) return;
      void runAction(`branch-sync:${branch.name}`, async () => {
        if (!api) return;
        const targetCwd = branchOperationCwd(branch, cwd);
        if (mode === "force-push") {
          await api.vcs.pushBranch({ cwd: targetCwd, branchName: branch.name, force: true });
          return;
        }
        if (mode === "force-pull") {
          await api.vcs.pullBranch({ cwd: targetCwd, branchName: branch.name, force: true });
          return;
        }
        if (!branch.current) {
          console.warn("Ignored diverged merge sync for a non-current branch", {
            branchName: branch.name,
          });
          return;
        }
        await api.vcs.pullBranch({ cwd: targetCwd, branchName: branch.name, merge: true });
        await api.vcs.pushBranch({ cwd: targetCwd, branchName: branch.name });
      });
    },
    [api, cwd, divergedSyncBranch, runAction],
  );

  const fetchActionableBranches = useCallback(
    (force = false) =>
      runAction(
        "work-fetch",
        () =>
          api?.vcs.fetchAllRemotes({ cwd, ...(force ? { force: true } : {}) }) ?? Promise.resolve(),
      ),
    [api, cwd, runAction],
  );

  const automaticallyFetchActionableBranches = useCallback(async () => {
    if (!api) return;
    try {
      await api.vcs.fetchAllRemotes({ cwd });
      await refresh();
    } catch {
      // Automatic refresh remains best-effort. Explicit Fetch owns surfaced
      // failures and always bypasses the shared background policy.
    }
  }, [api, cwd, refresh]);

  useEffect(() => {
    if (!api) return;
    if (sourceControlAllRemotesFetchIntervalMs <= 0) {
      initialFetchCwdRef.current = null;
      return;
    }
    if (initialFetchCwdRef.current === cwd) return;
    initialFetchCwdRef.current = cwd;
    void automaticallyFetchActionableBranches();
  }, [
    api,
    automaticallyFetchActionableBranches,
    cwd,
    initialFetchCwdRef,
    sourceControlAllRemotesFetchIntervalMs,
  ]);

  useEffect(() => {
    if (!api) return;
    if (sourceControlAllRemotesFetchIntervalMs <= 0) return;
    const interval = window.setInterval(() => {
      if (runningActions.has("work-fetch")) return;
      void automaticallyFetchActionableBranches();
    }, sourceControlAllRemotesFetchIntervalMs);
    return () => window.clearInterval(interval);
  }, [
    api,
    automaticallyFetchActionableBranches,
    runningActions,
    sourceControlAllRemotesFetchIntervalMs,
  ]);

  const runPanelCommit = useCallback(
    (message: string) => {
      const commitMessage = message.trim();
      return runAction("changes-commit", async () => {
        setCommitDialogOpen(false);
        setDialogCommitMessage("");
        if (!api) return;
        await api.vcs.commitStaged({
          cwd,
          paths: [...selectedChangePathList],
          ...(commitMessage ? { message: commitMessage } : {}),
        });
      });
    },
    [api, cwd, runAction, selectedChangePathList],
  );

  const runGeneratedPanelCommit = useCallback(() => {
    return runPanelCommit("");
  }, [runPanelCommit]);

  const openCommitDialog = useCallback(() => {
    setDialogCommitMessage("");
    setCommitDialogOpen(true);
  }, []);

  const createStash = useCallback(
    (paths: readonly string[], message?: string, targetCwd = cwd, actionKey = "changes-stash") => {
      const stashMessage = message?.trim();
      return runAction(actionKey, async () => {
        if (!api) return;
        await api.vcs.createStash({
          cwd: targetCwd,
          mode: "all",
          includeUntracked: true,
          paths: [...paths],
          ...(stashMessage ? { message: stashMessage } : {}),
        });
      });
    },
    [api, cwd, runAction],
  );

  const runGeneratedPanelStash = useCallback(() => {
    return createStash(selectedChangePathList);
  }, [createStash, selectedChangePathList]);

  const openStashDialog = useCallback(
    (label: string, paths: readonly string[], targetCwd = cwd, actionKey = "changes-stash") => {
      setStashDialogTarget({ label, cwd: targetCwd, actionKey, paths });
      setDialogStashMessage("");
    },
    [cwd],
  );

  const runPanelStash = useCallback(() => {
    if (!stashDialogTarget) return;
    const paths = stashDialogTarget.paths;
    const message = dialogStashMessage.trim();
    const targetCwd = stashDialogTarget.cwd;
    const actionKey = stashDialogTarget.actionKey;
    setStashDialogTarget(null);
    setDialogStashMessage("");
    void createStash(paths, message, targetCwd, actionKey);
  }, [createStash, dialogStashMessage, stashDialogTarget]);

  const commitSelectedInCwd = useCallback(
    (input: {
      readonly targetCwd: string;
      readonly actionKey: string;
      readonly files: readonly PanelChangedFile[];
    }) =>
      runAction(input.actionKey, async () => {
        if (!api) return;
        const paths = uniquePaths(input.files.flatMap((file) => operationPathsForFile(file)));
        if (paths.length === 0) return;
        await api.vcs.commitStaged({ cwd: input.targetCwd, paths });
      }),
    [api, runAction],
  );

  const stashSelectedInCwd = useCallback(
    (input: {
      readonly targetCwd: string;
      readonly actionKey: string;
      readonly paths: readonly string[];
      readonly message?: string;
    }) => createStash(input.paths, input.message, input.targetCwd, input.actionKey),
    [createStash],
  );

  const discardSelectedInCwd = useCallback(
    (input: {
      readonly targetCwd: string;
      readonly actionKey: string;
      readonly files: readonly PanelChangedFile[];
    }) =>
      void (async () => {
        if (input.files.length === 0) return;
        const countLabel =
          input.files.length === 1
            ? "the selected change"
            : `${input.files.length} selected changes`;
        if (!(await confirm(`Discard ${countLabel}?`))) return;
        const stagedPaths = uniquePaths(
          input.files
            .filter((file) => file.hasStagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        const unstagedPaths = uniquePaths(
          input.files
            .filter((file) => file.hasUnstagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        await runAction(input.actionKey, async () => {
          if (!api) return;
          if (unstagedPaths.length > 0) {
            await api.vcs.discardFiles({
              cwd: input.targetCwd,
              paths: unstagedPaths,
              staged: false,
            });
          }
          if (stagedPaths.length > 0) {
            await api.vcs.discardFiles({ cwd: input.targetCwd, paths: stagedPaths, staged: true });
          }
        });
      })(),
    [api, confirm, runAction],
  );

  const discardSelectedChanges = useCallback(
    () =>
      void (async () => {
        if (selectedChangedFiles.length === 0) return;
        const countLabel =
          selectedChangedFiles.length === 1
            ? "the selected change"
            : `${selectedChangedFiles.length} selected changes`;
        if (!(await confirm(`Discard ${countLabel}?`))) return;
        const stagedPaths = uniquePaths(
          selectedChangedFiles
            .filter((file) => file.hasStagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        const unstagedPaths = uniquePaths(
          selectedChangedFiles
            .filter((file) => file.hasUnstagedChanges)
            .flatMap((file) => operationPathsForFile(file)),
        );
        await runAction("changes-discard-selected", async () => {
          if (!api) return;
          if (unstagedPaths.length > 0) {
            await api.vcs.discardFiles({ cwd, paths: unstagedPaths, staged: false });
          }
          if (stagedPaths.length > 0) {
            await api.vcs.discardFiles({ cwd, paths: stagedPaths, staged: true });
          }
        });
      })(),
    [api, confirm, cwd, runAction, selectedChangedFiles],
  );

  return {
    checkoutCommitDetached,
    commitSelectedInCwd,
    confirm,
    copyText,
    closeCreateBranchDialog,
    createBranchCommitTarget,
    createBranchFromCommit,
    createBranchName,
    createStash,
    deleteBranch,
    discardSelectedChanges,
    discardSelectedInCwd,
    fetchActionableBranches,
    fileDiffListProps,
    mergeBranchIntoCurrent,
    openCommitDialog,
    openContextMenu,
    openFileChangeContextMenu,
    openFilePanel,
    openInVsCode,
    openStashDialog,
    publishBranch,
    publishBranchWithRemoteChoice,
    rebaseCurrentOnto,
    renderFileDiff,
    revertCommit,
    runAction,
    runBranchSync,
    runCreateBranchFromCommit,
    runDivergedSync,
    runGeneratedPanelCommit,
    runGeneratedPanelStash,
    runPanelCommit,
    runPanelStash,
    stashSelectedInCwd,
    setCreateBranchName,
    switchRef,
    syncBranch,
    toggleFileDiff,
    undoCommit,
  };
}
