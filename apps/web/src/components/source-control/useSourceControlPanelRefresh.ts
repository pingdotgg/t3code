import { useCallback, useEffect } from "react";

import { drainPanelRefreshQueue, vcsPanelSnapshotFingerprint } from "./SourceControlPanel.logic";
import { errorMessage } from "./SourceControlPanelModel";
import { isSourceControlPanelCommandInterrupted } from "~/state/sourceControlPanel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";

export function useSourceControlPanelRefresh(state: SourceControlPanelState) {
  const {
    api,
    cwd,
    expandedFileDiffs,
    expandedFileDiffsRef,
    expandedTree,
    expandedTreeRef,
    hydrateExpandedBranchDetails,
    hydrateExpandedStashDetails,
    lastFocusRefreshAtRef,
    lastVcsStatusRefreshRef,
    refreshInFlightRef,
    refreshQueuedModeRef,
    reloadExpandedWorkingTreeDiffs,
    resetWorkingTreeFileEnrichment,
    setError,
    setLoading,
    setLoadingBranchDetails,
    setSnapshot,
    snapshotFingerprintRef,
    snapshotRef,
    sourceControlAllRemotesFetchIntervalMs,
    syncChangedPathSelection,
    syncWorktreeChangedPathSelection,
    vcsStatus,
    vcsStatusFingerprint,
  } = state;
  const refresh = useCallback(
    async (refreshMode: "full" | "working-tree" = "full") => {
      if (!api) {
        setError("Version Control panel is unavailable for this connection runtime.");
        setLoading(false);
        return;
      }
      if (refreshInFlightRef.current) {
        refreshQueuedModeRef.current =
          refreshQueuedModeRef.current === "full" || refreshMode === "full"
            ? "full"
            : "working-tree";
        return;
      }
      refreshInFlightRef.current = true;
      setLoading(true);
      try {
        await drainPanelRefreshQueue({
          initialMode: refreshMode,
          clearQueuedMode: () => {
            refreshQueuedModeRef.current = null;
          },
          readQueuedMode: () => refreshQueuedModeRef.current,
          run: async (mode) => {
            setError(null);
            const nextSnapshot = await api.vcs.panelSnapshot({ cwd, refresh: mode });
            const nextSnapshotFingerprint = vcsPanelSnapshotFingerprint(cwd, nextSnapshot);
            if (snapshotFingerprintRef.current === nextSnapshotFingerprint) {
              reloadExpandedWorkingTreeDiffs(nextSnapshot, { preserveLoaded: true });
              await hydrateExpandedBranchDetails(nextSnapshot);
              await hydrateExpandedStashDetails(nextSnapshot);
            } else {
              snapshotFingerprintRef.current = nextSnapshotFingerprint;
              snapshotRef.current = nextSnapshot;
              resetWorkingTreeFileEnrichment();
              syncChangedPathSelection(nextSnapshot.changeGroups);
              syncWorktreeChangedPathSelection(nextSnapshot.worktreeChangeSets);
              setSnapshot(nextSnapshot);
              reloadExpandedWorkingTreeDiffs(nextSnapshot, { preserveLoaded: true });
              await hydrateExpandedBranchDetails(nextSnapshot, { reloadAll: true });
              await hydrateExpandedStashDetails(nextSnapshot, { reloadAll: true });
            }
          },
          onError: (nextError) => {
            if (isSourceControlPanelCommandInterrupted(nextError)) return;
            setError(errorMessage(nextError));
          },
        });
      } finally {
        refreshInFlightRef.current = false;
        setLoadingBranchDetails((current) => (current.size === 0 ? current : new Set()));
        setLoading(false);
      }
    },
    [
      api,
      cwd,
      hydrateExpandedBranchDetails,
      hydrateExpandedStashDetails,
      reloadExpandedWorkingTreeDiffs,
      resetWorkingTreeFileEnrichment,
      syncChangedPathSelection,
      syncWorktreeChangedPathSelection,
    ],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (vcsStatus.data === undefined || vcsStatus.data === null || vcsStatusFingerprint === null)
      return;
    const previous = lastVcsStatusRefreshRef.current;
    if (previous?.data === vcsStatus.data && previous.fingerprint === vcsStatusFingerprint) return;
    lastVcsStatusRefreshRef.current = {
      data: vcsStatus.data,
      fingerprint: vcsStatusFingerprint,
    };
    void refresh("working-tree");
  }, [refresh, vcsStatus.data, vcsStatusFingerprint]);

  useEffect(() => {
    expandedTreeRef.current = expandedTree;
  }, [expandedTree]);

  useEffect(() => {
    expandedFileDiffsRef.current = expandedFileDiffs;
  }, [expandedFileDiffs]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusRefreshAtRef.current < 1_000) return;
      lastFocusRefreshAtRef.current = now;
      if (!api || sourceControlAllRemotesFetchIntervalMs <= 0) {
        void refresh();
        return;
      }
      void (async () => {
        try {
          await api.vcs.fetchAllRemotes({ cwd });
        } catch {
          // Focus refresh still reconciles the local repository snapshot when
          // an automatic network refresh is unavailable or policy-gated.
        } finally {
          await refresh();
        }
      })();
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [api, cwd, refresh, sourceControlAllRemotesFetchIntervalMs]);

  return { refresh };
}
