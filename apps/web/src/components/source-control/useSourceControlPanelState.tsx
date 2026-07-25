import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsPanelWorktreeChangeSet,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";

import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useTheme } from "~/hooks/useTheme";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  resolveSourceControlPanelPresentationState,
  useSourceControlPanelApi,
} from "~/state/sourceControlPanel";
import { vcsEnvironment } from "~/state/vcs";

import { shouldIncludeBranchPickerItem } from "../BranchToolbar.logic";
import {
  beginPanelFileDiffLoad,
  completePanelFileDiffLoad,
  failPanelFileDiffLoad,
  mergeChangeGroups,
  type PanelChangedFile,
} from "./SourceControlPanel.logic";
import {
  readCachedSourceControlPanelState,
  sourceControlPanelStateCacheKey,
  writeCachedSourceControlPanelState,
} from "./SourceControlPanelCache";
import {
  DEFAULT_SECTION_WEIGHTS,
  applyWorkingTreeFileEnrichment,
  branchActivityTimestamp,
  compareBaseRefNames,
  enrichmentFileKey,
  errorMessage,
  expandedBranchesForSnapshot,
  expandedStashesForSnapshot,
  mapBranchDetails,
  operationPathsForFile,
  shouldEnrichWorkingTreeFile,
  splitEnrichmentFileKey,
  uniquePaths,
  worktreeChangeSetId,
  type FileDiffLoadState,
  type FileDiffSource,
  type SectionKey,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";
export interface SourceControlEnvironmentPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly filePanelThreadRef: ScopedThreadRef | null;
  readonly onThreadRefChange?: (input: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) => Promise<void> | void;
}

export function useSourceControlPanelState({
  cwd,
  environmentId,
  filePanelThreadRef,
  onThreadRefChange,
  threadId,
  worktreePath,
}: SourceControlEnvironmentPanelProps) {
  const { resolvedTheme } = useTheme();
  const commitMessageId = useId();
  const stashMessageId = useId();
  const gitActionScope = useMemo(() => ({ environmentId, cwd }), [cwd, environmentId]);
  const gitAction = useGitStackedAction(gitActionScope);
  const api = useSourceControlPanelApi(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const vcsStatus = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd },
    }),
  );
  const panelStateCacheKey = useMemo(
    () => sourceControlPanelStateCacheKey({ environmentId, threadId, cwd, worktreePath }),
    [cwd, environmentId, threadId, worktreePath],
  );
  const cachedPanelState = useMemo(() => {
    return readCachedSourceControlPanelState(panelStateCacheKey);
  }, [panelStateCacheKey]);
  const cachedSnapshot = cachedPanelState?.snapshot ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const snapshotFingerprintRef = useRef<string | null>(
    cachedPanelState?.snapshotFingerprint ?? null,
  );
  const snapshotRef = useRef<VcsPanelSnapshotResult | null>(cachedSnapshot);
  const branchDetailsByRefRef = useRef<ReadonlyMap<string, VcsPanelBranchDetails>>(
    cachedPanelState?.branchDetailsByRef ?? new Map(),
  );
  const stashDetailsByKeyRef = useRef<ReadonlyMap<string, VcsPanelStashDetails>>(
    cachedPanelState?.stashDetailsByKey ?? new Map(),
  );
  const expandedTreeRef = useRef<ReadonlySet<string>>(cachedPanelState?.expandedTree ?? new Set());
  const expandedFileDiffsRef = useRef<ReadonlySet<string>>(
    cachedPanelState?.expandedFileDiffs ?? new Set(),
  );
  const fileDiffRequestIdsRef = useRef(new Map<string, number>());
  const lastFocusRefreshAtRef = useRef(0);
  const initialFetchCwdRef = useRef<string | null>(null);
  const lastVcsStatusRefreshRef = useRef<{
    readonly data: VcsStatusResult;
    readonly fingerprint: string;
  } | null>(null);
  const previousChangedPathsRef = useRef<ReadonlySet<string>>(
    cachedSnapshot
      ? new Set(mergeChangeGroups(cachedSnapshot.changeGroups).map((file) => file.path))
      : new Set(),
  );
  const previousWorktreeChangedPathsRef = useRef<ReadonlyMap<string, ReadonlySet<string>>>(
    cachedSnapshot
      ? new Map(
          cachedSnapshot.worktreeChangeSets.map((changeSet) => [
            worktreeChangeSetId(changeSet),
            new Set(mergeChangeGroups(changeSet.changeGroups).map((file) => file.path)),
          ]),
        )
      : new Map(),
  );
  const refreshInFlightRef = useRef(false);
  const refreshQueuedModeRef = useRef<"full" | "working-tree" | null>(null);
  const enrichedWorkingTreeFilesRef = useRef<ReadonlyMap<string, VcsPanelFileChange>>(
    cachedPanelState?.enrichedWorkingTreeFilesByPath ?? new Map(),
  );
  const hiddenWorkingTreePathsRef = useRef<ReadonlySet<string>>(
    cachedPanelState?.hiddenWorkingTreePaths ?? new Set(),
  );
  const pendingWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  const inFlightWorkingTreeEnrichmentPathsRef = useRef<Set<string>>(new Set());
  const workingTreeEnrichmentTimerRef = useRef<number | null>(null);
  const workingTreeEnrichmentGenerationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<VcsPanelSnapshotResult | null>(cachedSnapshot);
  const [loading, setLoading] = useState(true);
  const [runningActions, setRunningActions] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(
    () => cachedPanelState?.collapsed ?? new Set(["remotes"]),
  );
  const [sectionWeights, setSectionWeights] = useState(
    () => cachedPanelState?.sectionWeights ?? DEFAULT_SECTION_WEIGHTS,
  );
  const [expandedTree, setExpandedTree] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.expandedTree ?? new Set(),
  );
  const [collapsedDefaultTree, setCollapsedDefaultTree] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.collapsedDefaultTree ?? new Set(),
  );
  const [branchDetailsByRef, setBranchDetailsByRef] = useState<
    ReadonlyMap<string, VcsPanelBranchDetails>
  >(() => cachedPanelState?.branchDetailsByRef ?? new Map());
  const [compareBaseOverrides, setCompareBaseOverrides] = useState<ReadonlyMap<string, string>>(
    () => cachedPanelState?.compareBaseOverrides ?? new Map(),
  );
  const [loadingBranchDetails, setLoadingBranchDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [stashDetailsByKey, setStashDetailsByKey] = useState<
    ReadonlyMap<string, VcsPanelStashDetails>
  >(() => cachedPanelState?.stashDetailsByKey ?? new Map());
  const [loadingStashDetails, setLoadingStashDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedFileDiffs, setExpandedFileDiffs] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.expandedFileDiffs ?? new Set(),
  );
  const [fileDiffsByKey, setFileDiffsByKey] = useState<ReadonlyMap<string, FileDiffLoadState>>(
    () => cachedPanelState?.fileDiffsByKey ?? new Map(),
  );
  const [enrichedWorkingTreeFilesByPath, setEnrichedWorkingTreeFilesByPath] = useState<
    ReadonlyMap<string, VcsPanelFileChange>
  >(() => cachedPanelState?.enrichedWorkingTreeFilesByPath ?? new Map());
  const [hiddenWorkingTreePaths, setHiddenWorkingTreePaths] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.hiddenWorkingTreePaths ?? new Set(),
  );
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [divergedSyncBranch, setDivergedSyncBranch] = useState<VcsRef | null>(null);
  const [publishRemoteTarget, setPublishRemoteTarget] = useState<{
    readonly branch: VcsRef;
    readonly force: boolean;
  } | null>(null);
  const [compareBaseDialogTarget, setCompareBaseDialogTarget] = useState<{
    readonly branch: VcsRef;
    readonly detailsKey: string;
  } | null>(null);
  const [compareBaseQuery, setCompareBaseQuery] = useState("");
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [stashDialogTarget, setStashDialogTarget] = useState<{
    readonly label: string;
    readonly cwd: string;
    readonly actionKey: string;
    readonly paths: readonly string[];
  } | null>(null);
  const [dialogStashMessage, setDialogStashMessage] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [selectedChangePaths, setSelectedChangePaths] = useState<ReadonlySet<string>>(
    () => cachedPanelState?.selectedChangePaths ?? new Set(),
  );
  const [selectedWorktreeChangePaths, setSelectedWorktreeChangePaths] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => cachedPanelState?.selectedWorktreeChangePaths ?? new Map());
  const displayedChangeGroups = useMemo(
    () =>
      applyWorkingTreeFileEnrichment(
        snapshot?.changeGroups ?? [],
        cwd,
        enrichedWorkingTreeFilesByPath,
        hiddenWorkingTreePaths,
      ),
    [cwd, enrichedWorkingTreeFilesByPath, hiddenWorkingTreePaths, snapshot?.changeGroups],
  );
  const changedFiles = useMemo(
    () => mergeChangeGroups(displayedChangeGroups),
    [displayedChangeGroups],
  );
  const worktreeChangeSetViews = useMemo<WorkingTreeChangeSetView[]>(
    () =>
      (snapshot?.worktreeChangeSets ?? [])
        .map((changeSet) => {
          const id = worktreeChangeSetId(changeSet);
          const changeGroups = applyWorkingTreeFileEnrichment(
            changeSet.changeGroups,
            changeSet.worktreePath,
            enrichedWorkingTreeFilesByPath,
            hiddenWorkingTreePaths,
          );
          const files = mergeChangeGroups(changeGroups);
          return {
            id,
            label: changeSet.branchName,
            cwd: changeSet.worktreePath,
            branchName: changeSet.branchName,
            worktreePath: changeSet.worktreePath,
            current: false,
            changeGroups,
            files,
            selectedPaths:
              selectedWorktreeChangePaths.get(id) ?? new Set(files.map((file) => file.path)),
            activity: branchActivityTimestamp(changeSet),
          };
        })
        .filter((changeSet) => changeSet.files.length > 0),
    [
      enrichedWorkingTreeFilesByPath,
      hiddenWorkingTreePaths,
      selectedWorktreeChangePaths,
      snapshot?.worktreeChangeSets,
    ],
  );
  const compareBaseRefs = useMemo(() => compareBaseRefNames(snapshot), [snapshot]);
  const deferredCompareBaseQuery = useDeferredValue(compareBaseQuery);
  const normalizedCompareBaseQuery = deferredCompareBaseQuery.trim().toLowerCase();
  const filteredCompareBaseRefs = useMemo(
    () =>
      compareBaseRefs.filter((itemValue) =>
        shouldIncludeBranchPickerItem({
          itemValue,
          normalizedQuery: normalizedCompareBaseQuery,
          createBranchItemValue: null,
          checkoutPullRequestItemValue: null,
        }),
      ),
    [compareBaseRefs, normalizedCompareBaseQuery],
  );
  const changedPaths = useMemo(() => changedFiles.map((file) => file.path), [changedFiles]);
  const selectedChangedFiles = useMemo(
    () => changedFiles.filter((file) => selectedChangePaths.has(file.path)),
    [changedFiles, selectedChangePaths],
  );
  const selectedChangePathList = useMemo(
    () => uniquePaths(selectedChangedFiles.flatMap((file) => operationPathsForFile(file))),
    [selectedChangedFiles],
  );
  const allChangedFilesSelected =
    changedFiles.length > 0 && selectedChangedFiles.length === changedFiles.length;
  const toggleAllChangedFilesSelection = useCallback(() => {
    setSelectedChangePaths(allChangedFilesSelected ? new Set() : new Set(changedPaths));
  }, [allChangedFilesSelected, changedPaths]);
  const vcsStatusFingerprint = useMemo(() => {
    const status = vcsStatus.data;
    if (!status) return null;
    return JSON.stringify({
      refName: status.refName,
      hasUpstream: status.hasUpstream,
      aheadCount: status.aheadCount,
      behindCount: status.behindCount,
      workingTree: status.workingTree,
    });
  }, [vcsStatus.data]);
  const presentationState = useMemo(
    () =>
      resolveSourceControlPanelPresentationState({
        snapshot,
        loading,
        error,
        statusPending: vcsStatus.isPending,
        statusError: vcsStatus.error,
      }),
    [error, loading, snapshot, vcsStatus.error, vcsStatus.isPending],
  );
  const isActionRunning = useCallback(
    (actionKey: string) => runningActions.has(actionKey),
    [runningActions],
  );

  useEffect(() => {
    branchDetailsByRefRef.current = branchDetailsByRef;
  }, [branchDetailsByRef]);

  useEffect(() => {
    stashDetailsByKeyRef.current = stashDetailsByKey;
  }, [stashDetailsByKey]);

  useEffect(() => {
    writeCachedSourceControlPanelState(panelStateCacheKey, {
      snapshot,
      snapshotFingerprint: snapshotFingerprintRef.current,
      collapsed,
      sectionWeights,
      expandedTree,
      collapsedDefaultTree,
      branchDetailsByRef,
      compareBaseOverrides,
      stashDetailsByKey,
      expandedFileDiffs,
      fileDiffsByKey,
      enrichedWorkingTreeFilesByPath,
      hiddenWorkingTreePaths,
      selectedChangePaths,
      selectedWorktreeChangePaths,
    });
  }, [
    branchDetailsByRef,
    collapsed,
    collapsedDefaultTree,
    compareBaseOverrides,
    enrichedWorkingTreeFilesByPath,
    expandedFileDiffs,
    expandedTree,
    fileDiffsByKey,
    hiddenWorkingTreePaths,
    panelStateCacheKey,
    sectionWeights,
    selectedChangePaths,
    selectedWorktreeChangePaths,
    snapshot,
    stashDetailsByKey,
  ]);

  const resetWorkingTreeFileEnrichment = useCallback(() => {
    workingTreeEnrichmentGenerationRef.current += 1;
    if (workingTreeEnrichmentTimerRef.current !== null) {
      window.clearTimeout(workingTreeEnrichmentTimerRef.current);
      workingTreeEnrichmentTimerRef.current = null;
    }
    pendingWorkingTreeEnrichmentPathsRef.current.clear();
    inFlightWorkingTreeEnrichmentPathsRef.current.clear();
    enrichedWorkingTreeFilesRef.current = new Map();
    hiddenWorkingTreePathsRef.current = new Set();
    setEnrichedWorkingTreeFilesByPath(new Map());
    setHiddenWorkingTreePaths(new Set());
  }, []);

  const applyWorkingTreeFileEnrichmentResult = useCallback(
    (targetCwd: string, result: VcsPanelWorkingTreeFileEnrichmentResult) => {
      setEnrichedWorkingTreeFilesByPath((current) => {
        const next = new Map(current);
        for (const hiddenPath of result.hiddenPaths) {
          next.delete(enrichmentFileKey(targetCwd, hiddenPath));
        }
        for (const file of result.files) {
          next.set(enrichmentFileKey(targetCwd, file.path), file);
        }
        enrichedWorkingTreeFilesRef.current = next;
        return next;
      });
      setHiddenWorkingTreePaths((current) => {
        const next = new Set(current);
        for (const hiddenPath of result.hiddenPaths) {
          next.add(enrichmentFileKey(targetCwd, hiddenPath));
        }
        hiddenWorkingTreePathsRef.current = next;
        return next;
      });
    },
    [],
  );

  const flushWorkingTreeFileEnrichmentQueue = useCallback(() => {
    workingTreeEnrichmentTimerRef.current = null;
    if (!api) return;
    const keys = [...pendingWorkingTreeEnrichmentPathsRef.current].filter(
      (key) =>
        !enrichedWorkingTreeFilesRef.current.has(key) &&
        !hiddenWorkingTreePathsRef.current.has(key) &&
        !inFlightWorkingTreeEnrichmentPathsRef.current.has(key),
    );
    pendingWorkingTreeEnrichmentPathsRef.current.clear();
    if (keys.length === 0) return;

    const requestsByCwd = new Map<string, string[]>();
    for (const key of keys) {
      const parsed = splitEnrichmentFileKey(key);
      if (!parsed.cwd || !parsed.path) continue;
      const paths = requestsByCwd.get(parsed.cwd) ?? [];
      paths.push(parsed.path);
      requestsByCwd.set(parsed.cwd, paths);
      inFlightWorkingTreeEnrichmentPathsRef.current.add(key);
    }
    if (requestsByCwd.size === 0) return;

    const generation = workingTreeEnrichmentGenerationRef.current;
    void Promise.all(
      [...requestsByCwd].map(async ([targetCwd, paths]) => ({
        targetCwd,
        result: await api.vcs.enrichWorkingTreeFiles({ cwd: targetCwd, paths }),
      })),
    )
      .then((results) => {
        if (workingTreeEnrichmentGenerationRef.current !== generation) return;
        for (const { targetCwd, result } of results) {
          applyWorkingTreeFileEnrichmentResult(targetCwd, result);
        }
      })
      .catch((nextError: unknown) => {
        if (workingTreeEnrichmentGenerationRef.current === generation) {
          setError(errorMessage(nextError));
        }
      })
      .finally(() => {
        for (const key of keys) {
          inFlightWorkingTreeEnrichmentPathsRef.current.delete(key);
        }
      });
  }, [api, applyWorkingTreeFileEnrichmentResult]);

  const queueWorkingTreeFileEnrichment = useCallback(
    (file: PanelChangedFile, targetCwd: string) => {
      if (!api || !shouldEnrichWorkingTreeFile(file)) return;
      const key = enrichmentFileKey(targetCwd, file.path);
      if (
        enrichedWorkingTreeFilesRef.current.has(key) ||
        hiddenWorkingTreePathsRef.current.has(key) ||
        inFlightWorkingTreeEnrichmentPathsRef.current.has(key)
      ) {
        return;
      }
      pendingWorkingTreeEnrichmentPathsRef.current.add(key);
      if (workingTreeEnrichmentTimerRef.current !== null) return;
      workingTreeEnrichmentTimerRef.current = window.setTimeout(
        flushWorkingTreeFileEnrichmentQueue,
        50,
      );
    },
    [api, flushWorkingTreeFileEnrichmentQueue],
  );

  useEffect(
    () => () => {
      if (workingTreeEnrichmentTimerRef.current !== null) {
        window.clearTimeout(workingTreeEnrichmentTimerRef.current);
      }
    },
    [],
  );

  const syncChangedPathSelection = useCallback((groups: readonly VcsPanelChangeGroup[]) => {
    const nextChangedPaths = mergeChangeGroups(groups).map((file) => file.path);
    const currentPaths = new Set(nextChangedPaths);
    const previousPaths = previousChangedPathsRef.current;
    setSelectedChangePaths((current) => {
      const next = new Set([...current].filter((path) => currentPaths.has(path)));
      for (const path of nextChangedPaths) {
        if (!previousPaths.has(path)) {
          next.add(path);
        }
      }
      return next;
    });
    previousChangedPathsRef.current = currentPaths;
  }, []);

  const syncWorktreeChangedPathSelection = useCallback(
    (changeSets: readonly VcsPanelWorktreeChangeSet[]) => {
      const previousById = previousWorktreeChangedPathsRef.current;
      const nextPreviousById = new Map<string, ReadonlySet<string>>();
      setSelectedWorktreeChangePaths((current) => {
        const next = new Map<string, ReadonlySet<string>>();
        for (const changeSet of changeSets) {
          const id = worktreeChangeSetId(changeSet);
          const paths = mergeChangeGroups(changeSet.changeGroups).map((file) => file.path);
          const currentPaths = new Set(paths);
          if (currentPaths.size === 0) continue;
          const previousPaths = previousById.get(id) ?? new Set<string>();
          const selectedPaths = new Set(
            [...(current.get(id) ?? [])].filter((path) => currentPaths.has(path)),
          );
          for (const path of paths) {
            if (!previousPaths.has(path)) {
              selectedPaths.add(path);
            }
          }
          next.set(id, selectedPaths);
          nextPreviousById.set(id, currentPaths);
        }
        return next;
      });
      previousWorktreeChangedPathsRef.current = nextPreviousById;
    },
    [],
  );

  const fileDiffSourceKey = useCallback((source: FileDiffSource) => {
    switch (source.kind) {
      case "working-tree":
        return `working:${source.staged ? "staged" : "unstaged"}`;
      case "commit":
        return `commit:${source.sha}`;
      case "compare":
        return `compare:${source.baseRef}:${source.refName}`;
      case "stash":
        return `stash:${source.stashRef}`;
    }
  }, []);

  const fileDiffKey = useCallback(
    (file: VcsPanelFileChange, source: FileDiffSource, targetCwd = cwd) =>
      `${targetCwd}:${fileDiffSourceKey(source)}:${file.path}:${file.originalPath ?? ""}:${file.status}`,
    [cwd, fileDiffSourceKey],
  );

  const loadFileDiff = useCallback(
    (
      file: VcsPanelFileChange,
      source: FileDiffSource,
      targetCwd = cwd,
      options: { readonly preserveLoaded?: boolean } = {},
    ) => {
      if (!api) return;
      const key = fileDiffKey(file, source, targetCwd);
      const nextRequestId = (fileDiffRequestIdsRef.current.get(key) ?? 0) + 1;
      fileDiffRequestIdsRef.current.set(key, nextRequestId);
      setFileDiffsByKey((current) => {
        const currentState = current.get(key);
        const nextState = beginPanelFileDiffLoad(currentState, options);
        if (nextState === currentState) return current;
        const next = new Map(current);
        next.set(key, nextState);
        return next;
      });
      void api.vcs
        .readFileDiff({
          cwd: targetCwd,
          path: file.path,
          ...(file.originalPath ? { originalPath: file.originalPath } : {}),
          staged: source.kind === "working-tree" ? source.staged : false,
          source,
        })
        .then((result) => {
          if (fileDiffRequestIdsRef.current.get(key) !== nextRequestId) return;
          setFileDiffsByKey((current) => {
            const currentState = current.get(key);
            const nextState = completePanelFileDiffLoad(currentState, result.patch);
            if (nextState === currentState) return current;
            const next = new Map(current);
            next.set(key, nextState);
            return next;
          });
        })
        .catch((nextError: unknown) => {
          if (fileDiffRequestIdsRef.current.get(key) !== nextRequestId) return;
          setFileDiffsByKey((current) => {
            const currentState = current.get(key);
            const nextState = failPanelFileDiffLoad(currentState, errorMessage(nextError), options);
            if (nextState === currentState) return current;
            const next = new Map(current);
            next.set(key, nextState);
            return next;
          });
        });
    },
    [api, cwd, fileDiffKey],
  );

  const reloadExpandedWorkingTreeDiffs = useCallback(
    (nextSnapshot: VcsPanelSnapshotResult, options: { readonly preserveLoaded?: boolean } = {}) => {
      const expandedKeys = expandedFileDiffsRef.current;
      if (expandedKeys.size === 0) return;

      const reloadChangeSet = (targetCwd: string, files: readonly PanelChangedFile[]) => {
        for (const file of files) {
          const source = {
            kind: "working-tree",
            staged: !file.hasUnstagedChanges && file.hasStagedChanges,
          } satisfies FileDiffSource;
          if (expandedKeys.has(fileDiffKey(file, source, targetCwd))) {
            loadFileDiff(file, source, targetCwd, options);
          }
        }
      };

      reloadChangeSet(cwd, mergeChangeGroups(nextSnapshot.changeGroups));
      for (const changeSet of nextSnapshot.worktreeChangeSets) {
        reloadChangeSet(changeSet.worktreePath, mergeChangeGroups(changeSet.changeGroups));
      }
    },
    [cwd, fileDiffKey, loadFileDiff],
  );

  const hydrateExpandedBranchDetails = useCallback(
    async (
      nextSnapshot: VcsPanelSnapshotResult,
      options: { readonly reloadAll?: boolean } = {},
    ) => {
      if (!api) return;
      const expandedBranches = expandedBranchesForSnapshot(nextSnapshot, expandedTreeRef.current);
      const branchRequests = options.reloadAll
        ? expandedBranches
        : expandedBranches.filter((request) => {
            const existing = branchDetailsByRefRef.current.get(request.detailsKey);
            if (!existing) return true;
            return request.compareBaseRef ? existing.baseRef !== request.compareBaseRef : false;
          });
      const nextDetails = options.reloadAll
        ? new Map(mapBranchDetails(nextSnapshot.branchDetails))
        : new Map(branchDetailsByRefRef.current);

      if (branchRequests.length === 0) {
        if (options.reloadAll) {
          branchDetailsByRefRef.current = nextDetails;
          setBranchDetailsByRef(nextDetails);
        }
        return;
      }

      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        for (const request of branchRequests) {
          next.add(request.detailsKey);
        }
        return next;
      });
      try {
        const details = await Promise.all(
          branchRequests.map((request) =>
            api.vcs.branchDetails({
              cwd,
              branch: request.branch,
              defaultCompareRef: nextSnapshot.defaultCompareRef,
              compareBaseRef:
                request.compareBaseRef ??
                compareBaseOverrides.get(request.detailsKey) ??
                compareBaseOverrides.get(request.branch.name),
            }),
          ),
        );
        for (const [index, detail] of details.entries()) {
          const request = branchRequests[index];
          if (!request) continue;
          nextDetails.set(request.detailsKey, detail);
          if (request.detailsKey === request.branch.name) {
            nextDetails.set(detail.fullRefName, detail);
            nextDetails.set(detail.name, detail);
          }
        }
        branchDetailsByRefRef.current = nextDetails;
        setBranchDetailsByRef(nextDetails);
      } finally {
        setLoadingBranchDetails((current) => {
          const next = new Set(current);
          for (const request of branchRequests) {
            next.delete(request.detailsKey);
          }
          return next;
        });
      }
    },
    [api, compareBaseOverrides, cwd],
  );

  const hydrateExpandedStashDetails = useCallback(
    async (
      nextSnapshot: VcsPanelSnapshotResult,
      options: { readonly reloadAll?: boolean } = {},
    ) => {
      if (!api) return;
      const expandedStashes = expandedStashesForSnapshot(nextSnapshot, expandedTreeRef.current);
      const stashRequests = options.reloadAll
        ? expandedStashes
        : expandedStashes.filter((stash) => !stashDetailsByKeyRef.current.has(stash.detailsKey));
      if (stashRequests.length === 0) return;

      setLoadingStashDetails((current) => {
        const next = new Set(current);
        for (const stash of stashRequests) {
          next.add(stash.detailsKey);
        }
        return next;
      });
      try {
        const details = await Promise.all(
          stashRequests.map((stash) => api.vcs.stashDetails({ cwd, stashRef: stash.stashRef })),
        );
        setStashDetailsByKey((current) => {
          const next = new Map(current);
          for (const [index, detail] of details.entries()) {
            const request = stashRequests[index];
            if (!request) continue;
            next.set(request.detailsKey, detail);
          }
          stashDetailsByKeyRef.current = next;
          return next;
        });
      } finally {
        setLoadingStashDetails((current) => {
          const next = new Set(current);
          for (const stash of stashRequests) {
            next.delete(stash.detailsKey);
          }
          return next;
        });
      }
    },
    [api, cwd],
  );

  return {
    addRemoteOpen,
    allChangedFilesSelected,
    api,
    applyWorkingTreeFileEnrichmentResult,
    branchDetailsByRef,
    branchDetailsByRefRef,
    cachedPanelState,
    changedFiles,
    changedPaths,
    collapsed,
    collapsedDefaultTree,
    commitDialogOpen,
    commitMessageId,
    compareBaseDialogTarget,
    compareBaseOverrides,
    compareBaseQuery,
    compareBaseRefs,
    containerRef,
    cwd,
    dialogCommitMessage,
    dialogStashMessage,
    displayedChangeGroups,
    divergedSyncBranch,
    enrichedWorkingTreeFilesByPath,
    enrichedWorkingTreeFilesRef,
    environmentId,
    error,
    expandedFileDiffs,
    expandedFileDiffsRef,
    expandedTree,
    expandedTreeRef,
    fileDiffKey,
    fileDiffRequestIdsRef,
    fileDiffSourceKey,
    filePanelThreadRef,
    fileDiffsByKey,
    filteredCompareBaseRefs,
    flushWorkingTreeFileEnrichmentQueue,
    gitAction,
    hiddenWorkingTreePaths,
    hiddenWorkingTreePathsRef,
    hydrateExpandedBranchDetails,
    hydrateExpandedStashDetails,
    inFlightWorkingTreeEnrichmentPathsRef,
    initialFetchCwdRef,
    isActionRunning,
    lastFocusRefreshAtRef,
    lastVcsStatusRefreshRef,
    loadFileDiff,
    loading,
    loadingBranchDetails,
    loadingStashDetails,
    onThreadRefChange,
    openInPreferredEditor,
    panelStateCacheKey,
    pendingWorkingTreeEnrichmentPathsRef,
    presentationState,
    previousChangedPathsRef,
    previousWorktreeChangedPathsRef,
    publishRemoteTarget,
    queueWorkingTreeFileEnrichment,
    refreshInFlightRef,
    refreshQueuedModeRef,
    reloadExpandedWorkingTreeDiffs,
    remoteName,
    remoteUrl,
    resetWorkingTreeFileEnrichment,
    resolvedTheme,
    runningActions,
    sectionWeights,
    selectedChangePathList,
    selectedChangePaths,
    selectedChangedFiles,
    selectedWorktreeChangePaths,
    serverConfig,
    setAddRemoteOpen,
    setBranchDetailsByRef,
    setCollapsed,
    setCollapsedDefaultTree,
    setCommitDialogOpen,
    setCompareBaseDialogTarget,
    setCompareBaseOverrides,
    setCompareBaseQuery,
    setDialogCommitMessage,
    setDialogStashMessage,
    setDivergedSyncBranch,
    setEnrichedWorkingTreeFilesByPath,
    setError,
    setExpandedFileDiffs,
    setExpandedTree,
    setFileDiffsByKey,
    setHiddenWorkingTreePaths,
    setLoading,
    setLoadingBranchDetails,
    setLoadingStashDetails,
    setPublishRemoteTarget,
    setRemoteName,
    setRemoteUrl,
    setRunningActions,
    setSectionWeights,
    setSelectedChangePaths,
    setSelectedWorktreeChangePaths,
    setSnapshot,
    setStashDetailsByKey,
    setStashDialogTarget,
    snapshot,
    snapshotFingerprintRef,
    snapshotRef,
    stashDetailsByKey,
    stashDetailsByKeyRef,
    stashDialogTarget,
    stashMessageId,
    syncChangedPathSelection,
    syncWorktreeChangedPathSelection,
    threadId,
    toggleAllChangedFilesSelection,
    vcsStatus,
    vcsStatusFingerprint,
    workingTreeEnrichmentGenerationRef,
    workingTreeEnrichmentTimerRef,
    worktreeChangeSetViews,
    worktreePath,
  };
}

export type SourceControlPanelState = ReturnType<typeof useSourceControlPanelState>;
