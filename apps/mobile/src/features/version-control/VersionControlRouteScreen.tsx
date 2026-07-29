import type {
  VcsPanelBranchDetails,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsPanelStashDetails,
  VcsPanelSnapshotResult,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { panelBranchOperationCwd, panelBranchSyncState } from "@t3tools/shared/sourceControl";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import {
  actionableLocalBranches,
  applyWorkingTreeEnrichments,
  beginDetailRequest,
  branchOwnsOperationCwd,
  clearResolvedDetailError,
  detailRequestIsCurrent,
  discardableFiles,
  discardPathGroups,
  operationPaths,
  panelChangeSets,
  reconcileSelectedPaths,
  selectedFileStats,
  snapshotForCwd,
  snapshotIsPendingForCwd,
  snapshotRequestIsCurrent,
  stashIdentityKey,
  workingTreeDiffIsStaged,
  workingTreeEnrichmentRequests,
  type VersionControlChangeSet,
} from "./versionControlModel";
import {
  VersionControlCommandInterrupted,
  useVersionControlPanelApi,
} from "./useVersionControlPanelApi";
import { retryInterruptedVersionControlRequest } from "./versionControlRequest";
import {
  BranchCommitRow,
  CompactTag,
  PublishRemoteDialog,
  SectionHeader,
  type PublishRequest,
} from "./VersionControlRouteComponents";
import { VersionControlRouteView } from "./VersionControlRouteView";

type VersionControlRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;

interface FileDiffRequest {
  readonly cwd: string;
  readonly file: VcsPanelFileChange;
  readonly source: FileDiffSource;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The Version Control operation failed.";
}

export function useVersionControlRouteController(props: VersionControlRouteScreenProps) {
  const insets = useSafeAreaInsets();
  const subtleIconColor = useThemeColor("--color-icon-subtle");
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitActions = useSelectedThreadGitActions();
  const api = useVersionControlPanelApi(environmentId);
  const statusQuery = useEnvironmentQuery(
    selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const [scopedSnapshot, setScopedSnapshot] = useState<{
    readonly cwd: string;
    readonly snapshot: VcsPanelSnapshotResult;
  } | null>(null);
  const snapshot = snapshotForCwd(scopedSnapshot, selectedThreadCwd);
  const [loading, setLoading] = useState(true);
  const [settledSnapshotCwd, setSettledSnapshotCwd] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [actionableExpanded, setActionableExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(
    () => new Set(selectedThreadCwd ? [`changes:${selectedThreadCwd}`] : []),
  );
  const expandedRowsRef = useRef<ReadonlySet<string>>(expandedRows);
  const [selectedByCwd, setSelectedByCwd] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map(),
  );
  const knownPathsByCwd = useRef(new Map<string, Set<string>>());
  const initializedChangeSetCwds = useRef(new Set<string>());
  const [branchDetails, setBranchDetails] = useState<ReadonlyMap<string, VcsPanelBranchDetails>>(
    new Map(),
  );
  const [stashDetails, setStashDetails] = useState<ReadonlyMap<string, VcsPanelStashDetails>>(
    new Map(),
  );
  const [detailErrors, setDetailErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [publishRequest, setPublishRequest] = useState<PublishRequest | null>(null);
  const initiallyFetchedCwds = useRef(new Set<string>());
  const snapshotRequestId = useRef(0);
  const detailRequestIds = useRef(new Map<string, number>());
  const selectedThreadCwdRef = useRef(selectedThreadCwd);
  const snapshotRevision = useRef(0);
  const snapshotFingerprint = useRef<string | null>(null);

  useLayoutEffect(() => {
    selectedThreadCwdRef.current = selectedThreadCwd;
  }, [selectedThreadCwd]);

  useEffect(() => {
    expandedRowsRef.current = expandedRows;
  }, [expandedRows]);

  const syncSelections = useCallback((nextSnapshot: VcsPanelSnapshotResult, cwd: string) => {
    const changeSets = panelChangeSets(nextSnapshot, cwd);
    const newlyInitializedCurrentCwds = changeSets.flatMap((changeSet) => {
      if (initializedChangeSetCwds.current.has(changeSet.cwd)) return [];
      initializedChangeSetCwds.current.add(changeSet.cwd);
      return changeSet.current ? [changeSet.cwd] : [];
    });
    const previousKnownPaths = knownPathsByCwd.current;
    const nextKnownPaths = new Map(
      changeSets.map(
        (changeSet) => [changeSet.cwd, new Set(changeSet.files.map((file) => file.path))] as const,
      ),
    );
    knownPathsByCwd.current = nextKnownPaths;

    setExpandedRows((current) => {
      const next = new Set(current);
      for (const changeSetCwd of newlyInitializedCurrentCwds) next.add(`changes:${changeSetCwd}`);
      return next;
    });
    setSelectedByCwd((current) =>
      reconcileSelectedPaths({
        changeSets,
        previousKnownPaths,
        selectedByCwd: current,
      }),
    );
  }, []);

  const refreshSnapshot = useCallback(
    async (
      options: {
        readonly pull?: boolean;
        readonly refresh?: "full" | "working-tree";
      } = {},
    ) => {
      const requestCwd = selectedThreadCwd;
      if (requestCwd !== selectedThreadCwdRef.current) return;
      const requestId = ++snapshotRequestId.current;
      setRefreshing(options.pull === true);
      if (!requestCwd) {
        if (requestId === snapshotRequestId.current) {
          setSettledSnapshotCwd(null);
          setLoading(false);
          setRefreshing(false);
        }
        return;
      }
      setSettledSnapshotCwd((current) => (current === requestCwd ? null : current));
      try {
        const rawSnapshot = await api.snapshot({
          cwd: requestCwd,
          refresh: options.refresh ?? "full",
        });
        if (
          !snapshotRequestIsCurrent(
            requestId,
            snapshotRequestId.current,
            requestCwd,
            selectedThreadCwdRef.current,
          )
        ) {
          return;
        }
        const enrichmentResults = await Promise.allSettled(
          workingTreeEnrichmentRequests(rawSnapshot, requestCwd).map(
            async (request) => [request.cwd, await api.enrichWorkingTreeFiles(request)] as const,
          ),
        );
        const enrichmentEntries = enrichmentResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (
          !snapshotRequestIsCurrent(
            requestId,
            snapshotRequestId.current,
            requestCwd,
            selectedThreadCwdRef.current,
          )
        ) {
          return;
        }
        const next = applyWorkingTreeEnrichments(
          rawSnapshot,
          requestCwd,
          new Map(enrichmentEntries),
        );
        const nextFingerprint = `${requestCwd}\0${JSON.stringify(next)}`;
        if (snapshotFingerprint.current !== nextFingerprint) {
          snapshotFingerprint.current = nextFingerprint;
          snapshotRevision.current += 1;
          setBranchDetails(new Map());
          setStashDetails(new Map());
          setDetailErrors(new Map());
          setExpandedRows(
            (current) =>
              new Set(
                [...current].filter(
                  (key) =>
                    !key.startsWith("branch:") &&
                    !key.startsWith("fork:") &&
                    !key.startsWith("commit:") &&
                    !key.startsWith("stash:"),
                ),
              ),
          );
        }
        setScopedSnapshot({ cwd: requestCwd, snapshot: next });
        syncSelections(next, requestCwd);
        setError(null);
      } catch (cause) {
        if (
          snapshotRequestIsCurrent(
            requestId,
            snapshotRequestId.current,
            requestCwd,
            selectedThreadCwdRef.current,
          ) &&
          !(cause instanceof VersionControlCommandInterrupted)
        ) {
          setError(errorMessage(cause));
        }
      } finally {
        if (
          snapshotRequestIsCurrent(
            requestId,
            snapshotRequestId.current,
            requestCwd,
            selectedThreadCwdRef.current,
          )
        ) {
          setSettledSnapshotCwd(requestCwd);
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [api, selectedThreadCwd, syncSelections],
  );

  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setBusyAction(label);
      setError(null);
      setMutationError(null);
      let succeeded = false;
      let actionError: string | null = null;
      try {
        await action();
        succeeded = true;
      } catch (cause) {
        if (!(cause instanceof VersionControlCommandInterrupted)) actionError = errorMessage(cause);
      } finally {
        await refreshSnapshot();
        statusQuery.refresh();
        if (actionError) setMutationError(actionError);
        setBusyAction(null);
      }
      return succeeded;
    },
    [refreshSnapshot, statusQuery],
  );

  useFocusEffect(
    useCallback(() => {
      if (!selectedThreadCwd) return;
      const cwd = selectedThreadCwd;
      void refreshSnapshot();
      if (!initiallyFetchedCwds.current.has(cwd)) {
        initiallyFetchedCwds.current.add(cwd);
        void api
          .fetchAllRemotes({ cwd })
          .then(() => refreshSnapshot())
          .catch(() => undefined);
      }
    }, [api, refreshSnapshot, selectedThreadCwd]),
  );

  const statusFingerprint = statusQuery.data ? JSON.stringify(statusQuery.data) : null;
  const lastStatusRefresh = useRef<{
    readonly data: VcsStatusResult;
    readonly fingerprint: string;
  } | null>(null);
  useEffect(() => {
    if (!statusQuery.data || !statusFingerprint) return;
    const previous = lastStatusRefresh.current;
    if (previous?.data === statusQuery.data && previous.fingerprint === statusFingerprint) return;
    lastStatusRefresh.current = {
      data: statusQuery.data,
      fingerprint: statusFingerprint,
    };
    if (previous) void refreshSnapshot({ refresh: "working-tree" });
  }, [refreshSnapshot, statusFingerprint, statusQuery.data]);

  const changeSets = useMemo(
    () => (snapshot && selectedThreadCwd ? panelChangeSets(snapshot, selectedThreadCwd) : []),
    [selectedThreadCwd, snapshot],
  );
  const localBranches = useMemo(
    () => (snapshot ? actionableLocalBranches(snapshot) : []),
    [snapshot],
  );
  const actionCount =
    changeSets.length +
    localBranches.length +
    (snapshot?.actionableForkBranches.length ?? 0) +
    (snapshot?.stashes.length ?? 0);
  const busy = busyAction !== null;
  const headerToolbar = (
    <NativeHeaderToolbar placement="right">
      <NativeHeaderToolbar.Button
        accessibilityLabel="Close Version Control"
        icon="xmark"
        onPress={() => navigation.goBack()}
        separateBackground
      />
    </NativeHeaderToolbar>
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      expandedRowsRef.current = next;
      return next;
    });
  }, []);

  const openFileDiff = useCallback(
    (request: FileDiffRequest) => {
      navigation.navigate("VersionControlDiff", {
        environmentId: String(environmentId),
        cwd: request.cwd,
        file: request.file,
        source: request.source,
      });
    },
    [environmentId, navigation],
  );

  const toggleSelectedFile = useCallback((cwd: string, path: string) => {
    setSelectedByCwd((current) => {
      const next = new Map(current);
      const selected = new Set(next.get(cwd) ?? []);
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      next.set(cwd, selected);
      return next;
    });
  }, []);

  const selectAllFiles = useCallback((changeSet: VersionControlChangeSet) => {
    setSelectedByCwd((current) => {
      const next = new Map(current);
      const selected = next.get(changeSet.cwd) ?? new Set();
      next.set(
        changeSet.cwd,
        selected.size === changeSet.files.length
          ? new Set()
          : new Set(changeSet.files.map((file) => file.path)),
      );
      return next;
    });
  }, []);

  const selectedFiles = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const selected = selectedByCwd.get(changeSet.cwd) ?? new Set();
      return changeSet.files.filter((file) => selected.has(file.path));
    },
    [selectedByCwd],
  );

  const commitSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      void runAction("commit", async () => {
        await api.commitStaged({ cwd: changeSet.cwd, paths });
      });
    },
    [api, runAction, selectedFiles],
  );

  const stashSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      void runAction("stash", () =>
        api.createStash({ cwd: changeSet.cwd, paths, includeUntracked: true }),
      );
    },
    [api, runAction, selectedFiles],
  );

  const discardSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = discardableFiles(selectedFiles(changeSet));
      const paths = discardPathGroups(files);
      if (paths.staged.length === 0 && paths.unstaged.length === 0) return;
      Alert.alert(
        "Discard selected changes?",
        `This permanently discards changes in ${files.length} selected file${files.length === 1 ? "" : "s"}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () =>
              void runAction("discard", async () => {
                if (paths.unstaged.length > 0) {
                  await api.discardFiles({
                    cwd: changeSet.cwd,
                    paths: paths.unstaged,
                  });
                }
                if (paths.staged.length > 0) {
                  await api.discardFiles({
                    cwd: changeSet.cwd,
                    paths: paths.staged,
                    staged: true,
                  });
                }
              }),
          },
        ],
      );
    },
    [api, runAction, selectedFiles],
  );

  const loadBranchDetails = useCallback(
    (branch: VcsRef, key: string, compareBaseRef?: string) => {
      const wasExpanded = expandedRowsRef.current.has(key);
      toggleExpanded(key);
      if (!snapshot || branchDetails.has(key) || wasExpanded) return;
      const previousDetailError = detailErrors.get(key) ?? null;
      const revision = snapshotRevision.current;
      const requestId = beginDetailRequest(detailRequestIds.current, key);
      setDetailErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      void retryInterruptedVersionControlRequest(() =>
        api.branchDetails({
          cwd: selectedThreadCwd ?? "",
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          ...(compareBaseRef ? { compareBaseRef } : {}),
        }),
      )
        .then((details) => {
          if (
            revision !== snapshotRevision.current ||
            !detailRequestIsCurrent(detailRequestIds.current, key, requestId)
          ) {
            return;
          }
          setBranchDetails((current) => new Map(current).set(key, details));
          setDetailErrors((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setError((current) => clearResolvedDetailError(current, previousDetailError));
        })
        .catch((cause) => {
          if (
            revision === snapshotRevision.current &&
            detailRequestIsCurrent(detailRequestIds.current, key, requestId) &&
            !(cause instanceof VersionControlCommandInterrupted)
          ) {
            const message = errorMessage(cause);
            setDetailErrors((current) => new Map(current).set(key, message));
            setError(message);
          }
        });
    },
    [api, branchDetails, detailErrors, selectedThreadCwd, snapshot, toggleExpanded],
  );

  const publishBranch = useCallback(
    (branch: VcsRef, targetCwd: string) => {
      if (!snapshot) return;
      if (snapshot.remotes.length === 0) {
        setError("Add a remote before publishing this branch.");
        return;
      }
      if (snapshot.remotes.length > 1) {
        setPublishRequest({ branchName: branch.name, targetCwd });
        return;
      }
      const remote = snapshot.remotes[0];
      if (!remote) return;
      void runAction("publish", () =>
        api.pushBranch({
          cwd: targetCwd,
          branchName: branch.name,
          remoteName: remote.name,
        }),
      );
    },
    [api, runAction, snapshot],
  );

  const publishToRemote = useCallback(
    (remoteName: string) => {
      const request = publishRequest;
      if (!request) return;
      setPublishRequest(null);
      void runAction("publish", () =>
        api.pushBranch({
          cwd: request.targetCwd,
          branchName: request.branchName,
          remoteName,
        }),
      );
    },
    [api, publishRequest, runAction],
  );

  const syncBranch = useCallback(
    (branch: VcsRef) => {
      if (!snapshot || !selectedThreadCwd) return;
      const state = panelBranchSyncState(branch, snapshot);
      const targetCwd = panelBranchOperationCwd(branch, selectedThreadCwd);
      if (state === "publish") {
        publishBranch(branch, targetCwd);
        return;
      }
      if (state === "push") {
        void runAction("push", () => api.pushBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      if (state === "pull") {
        void runAction("pull", () => api.pullBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      if (state === "fetch") {
        void runAction("fetch", () => api.fetchBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      const canMerge = branchOwnsOperationCwd(branch);
      Alert.alert("Branch has diverged", "Choose how to synchronize this branch.", [
        { text: "Cancel", style: "cancel" },
        ...(canMerge
          ? [
              {
                text: "Pull & merge",
                onPress: () =>
                  void runAction("merge-sync", () =>
                    api.pullBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      merge: true,
                    }),
                  ),
              },
            ]
          : []),
        {
          text: "More…",
          onPress: () =>
            Alert.alert("Destructive sync", "These actions overwrite one side of the branch.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Force pull",
                style: "destructive",
                onPress: () =>
                  void runAction("force-pull", () =>
                    api.pullBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      force: true,
                    }),
                  ),
              },
              {
                text: "Force push",
                style: "destructive",
                onPress: () =>
                  void runAction("force-push", () =>
                    api.pushBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      force: true,
                    }),
                  ),
              },
            ]),
        },
      ]);
    },
    [api, publishBranch, runAction, selectedThreadCwd, snapshot],
  );

  const switchBranch = useCallback(
    (branch: VcsRef) => {
      void runAction("switch", async () => {
        await gitActions.onCheckoutSelectedThreadBranch(branch.name, {
          throwOnFailure: true,
        });
      });
    },
    [gitActions, runAction],
  );

  const deleteBranch = useCallback(
    (branch: VcsRef) => {
      if (!selectedThreadCwd || branch.current || branch.worktreePath !== null) return;
      Alert.alert("Delete branch?", `Delete ${branch.name}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void runAction("delete-branch", () =>
              api.deleteBranch({
                cwd: selectedThreadCwd,
                branchName: branch.name,
              }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const mergeBranch = useCallback(
    (refName: string) => {
      if (!selectedThreadCwd) return;
      Alert.alert("Merge branch?", `Merge ${refName} into the current branch?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge",
          onPress: () =>
            void runAction("merge-branch", () =>
              api.mergeBranchIntoCurrent({ cwd: selectedThreadCwd, refName }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const rebaseBranch = useCallback(
    (refName: string) => {
      if (!selectedThreadCwd) return;
      Alert.alert("Rebase branch?", `Rebase the current branch onto ${refName}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rebase",
          onPress: () =>
            void runAction("rebase-branch", () =>
              api.rebaseCurrentOnto({ cwd: selectedThreadCwd, refName }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const loadStashDetails = useCallback(
    (stash: VcsPanelSnapshotResult["stashes"][number]) => {
      const detailsKey = stashIdentityKey(stash);
      const key = `stash:${detailsKey}`;
      const wasExpanded = expandedRowsRef.current.has(key);
      toggleExpanded(key);
      if (!selectedThreadCwd || stashDetails.has(detailsKey) || wasExpanded) return;
      const previousDetailError = detailErrors.get(key) ?? null;
      const revision = snapshotRevision.current;
      const requestId = beginDetailRequest(detailRequestIds.current, key);
      setDetailErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      void retryInterruptedVersionControlRequest(() =>
        api.stashDetails({ cwd: selectedThreadCwd, stashRef: stash.refName }),
      )
        .then((details) => {
          if (
            revision !== snapshotRevision.current ||
            !detailRequestIsCurrent(detailRequestIds.current, key, requestId)
          ) {
            return;
          }
          setStashDetails((current) => new Map(current).set(detailsKey, details));
          setDetailErrors((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
          setError((current) => clearResolvedDetailError(current, previousDetailError));
        })
        .catch((cause) => {
          if (
            revision === snapshotRevision.current &&
            detailRequestIsCurrent(detailRequestIds.current, key, requestId) &&
            !(cause instanceof VersionControlCommandInterrupted)
          ) {
            const message = errorMessage(cause);
            setDetailErrors((current) => new Map(current).set(key, message));
            setError(message);
          }
        });
    },
    [api, detailErrors, selectedThreadCwd, stashDetails, toggleExpanded],
  );

  return {
    actionableExpanded,
    actionCount,
    api,
    branchDetails,
    busy,
    busyAction,
    changeSets,
    commitSelected,
    deleteBranch,
    detailErrors,
    discardSelected,
    error,
    expandedRows,
    headerToolbar,
    insets,
    loadBranchDetails,
    loadStashDetails,
    loading: loading || snapshotIsPendingForCwd(snapshot, selectedThreadCwd, settledSnapshotCwd),
    localBranches,
    mergeBranch,
    mutationError,
    openFileDiff,
    publishRequest,
    publishToRemote,
    rebaseBranch,
    refreshing,
    refreshSnapshot,
    remoteName,
    remotesExpanded,
    remoteUrl,
    runAction,
    selectAllFiles,
    selectedByCwd,
    selectedFiles,
    selectedThread,
    selectedThreadCwd,
    setActionableExpanded,
    setError,
    setMutationError,
    setPublishRequest,
    setRemoteName,
    setRemotesExpanded,
    setRemoteUrl,
    setShowAddRemote,
    showAddRemote,
    snapshot,
    stashDetails,
    stashSelected,
    subtleIconColor,
    switchBranch,
    syncBranch,
    toggleExpanded,
    toggleSelectedFile,
  };
}

export type VersionControlRouteController = ReturnType<typeof useVersionControlRouteController>;

export function VersionControlRouteScreen(props: VersionControlRouteScreenProps) {
  return <VersionControlRouteView controller={useVersionControlRouteController(props)} />;
}
