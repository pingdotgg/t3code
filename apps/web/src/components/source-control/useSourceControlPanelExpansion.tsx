import type {
  EnvironmentId,
  ThreadId,
  VcsPanelBranchCommitsInput,
  VcsPanelBranchDetails,
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelWorktreeChangeSet,
  VcsRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { getRenderablePatch, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
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
  beginPanelFileDiffLoad,
  beginPanelDetailRequest,
  branchHasUpstream,
  branchOperationCwd,
  branchSyncState,
  drainPanelRefreshQueue,
  namedBranchOperationCwd,
  isLatestPanelDetailRequest,
  type PanelChangedFile,
  stashIdentityKey,
} from "./SourceControlPanel.logic";
import {
  COMMIT_PAGE_SIZE,
  MIN_SECTION_WEIGHT,
  SECTION_ORDER,
  WORKING_FILE_PREFETCH_MARGIN,
  branchActivityTimestamp,
  compareBaseRefNames,
  errorMessage,
  expandedStashesForSnapshot,
  formatReadableDate,
  localBranchForRemoteBranch,
  mapBranchDetails,
  remoteBranchRef,
  shouldFetchBeforePull,
  sumFiles,
  treeKey,
  worktreeChangeSetId,
  commitCountLabel,
  type FileDiffLoadState,
  type SectionKey,
} from "./SourceControlPanelModel";
import type { SourceControlPanelState } from "./useSourceControlPanelState";

type BranchCommitListKind = NonNullable<VcsPanelBranchCommitsInput["kind"]>;

export function useSourceControlPanelExpansion(state: SourceControlPanelState) {
  const {
    api,
    branchDetailsByRef,
    collapsed,
    collapsedDefaultTree,
    compareBaseDialogTarget,
    compareBaseOverrides,
    containerRef,
    cwd,
    expandedTree,
    panelStateCacheKey,
    sectionWeights,
    setBranchDetailsByRef,
    setCollapsed,
    setCollapsedDefaultTree,
    setCompareBaseDialogTarget,
    setCompareBaseOverrides,
    setCompareBaseQuery,
    setError,
    setExpandedTree,
    setLoadingBranchDetails,
    setLoadingStashDetails,
    setSectionWeights,
    setStashDetailsByKey,
    snapshot,
    stashDetailsByKey,
  } = state;
  const branchDetailRequestsRef = useRef(new Map<string, number>());
  const toggleSection = useCallback((key: SectionKey) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isTreeExpanded = useCallback(
    (key: string, defaultExpanded = false) =>
      defaultExpanded ? !collapsedDefaultTree.has(key) : expandedTree.has(key),
    [collapsedDefaultTree, expandedTree],
  );

  const toggleTree = useCallback((key: string, defaultExpanded = false) => {
    if (defaultExpanded) {
      setCollapsedDefaultTree((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    setExpandedTree((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadBranchDetails = useCallback(
    async (branch: VcsRef, compareBaseRef?: string, detailsKey = branch.name) => {
      if (!api || !snapshot) return;
      if (!compareBaseRef && branchDetailsByRef.has(detailsKey)) return;
      const requestId = beginPanelDetailRequest(branchDetailRequestsRef.current, detailsKey);
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const details = await api.vcs.branchDetails({
          cwd,
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          compareBaseRef:
            compareBaseRef ??
            compareBaseOverrides.get(detailsKey) ??
            compareBaseOverrides.get(branch.name),
        });
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        setBranchDetailsByRef((current) => {
          const next = new Map(current);
          next.set(detailsKey, details);
          if (detailsKey === branch.name) {
            next.set(details.fullRefName, details);
            next.set(details.name, details);
          }
          return next;
        });
      } catch (nextError) {
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        if (isSourceControlPanelCommandInterrupted(nextError)) return;
        setError(errorMessage(nextError));
      } finally {
        if (isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          setLoadingBranchDetails((current) => {
            const next = new Set(current);
            next.delete(detailsKey);
            return next;
          });
        }
      }
    },
    [api, branchDetailsByRef, compareBaseOverrides, cwd, snapshot],
  );

  const chooseCompareBase = useCallback(
    (baseRef: string) => {
      const target = compareBaseDialogTarget;
      setCompareBaseDialogTarget(null);
      setCompareBaseQuery("");
      if (!target) return;
      setCompareBaseOverrides((current) => {
        const next = new Map(current);
        next.set(target.detailsKey, baseRef);
        return next;
      });
      void loadBranchDetails(target.branch, baseRef, target.detailsKey);
    },
    [compareBaseDialogTarget, loadBranchDetails],
  );

  const toggleBranchTree = useCallback(
    (key: string, branch: VcsRef, compareBaseRef?: string, detailsKey = branch.name) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadBranchDetails(branch, compareBaseRef, detailsKey);
    },
    [expandedTree, loadBranchDetails, toggleTree],
  );

  const toggleBranchTreeFromKeyboard = useCallback(
    (
      key: string,
      branch: VcsRef,
      event: ReactKeyboardEvent<HTMLDivElement>,
      compareBaseRef?: string,
      detailsKey = branch.name,
    ) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleBranchTree(key, branch, compareBaseRef, detailsKey);
    },
    [toggleBranchTree],
  );

  const loadMoreBranchCommits = useCallback(
    async (
      branch: VcsRef,
      details: VcsPanelBranchDetails,
      kind: BranchCommitListKind,
      detailsKey = branch.name,
    ) => {
      const loadedCount =
        kind === "ahead"
          ? details.aheadCommits.length
          : kind === "behind"
            ? details.behindCommits.length
            : kind === "compare-history"
              ? details.compareCommits.length
              : details.commits.length;
      const remaining =
        kind === "ahead"
          ? details.aheadCommitsRemaining
          : kind === "behind"
            ? details.behindCommitsRemaining
            : kind === "compare-history"
              ? details.compareCommitsRemaining
              : details.commitsRemaining;
      if (!api || remaining <= 0) return;
      const requestedBaseRef = details.baseRef;
      const requestId = beginPanelDetailRequest(branchDetailRequestsRef.current, detailsKey);
      setLoadingBranchDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const result = await api.vcs.branchCommits({
          cwd,
          branch,
          baseRef: details.baseRef,
          kind,
          skip: loadedCount,
          limit: COMMIT_PAGE_SIZE,
        });
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        setBranchDetailsByRef((current) => {
          const nextDetails =
            current.get(detailsKey) ?? current.get(details.fullRefName) ?? details;
          if (nextDetails.baseRef !== requestedBaseRef) return current;
          const merged =
            kind === "ahead"
              ? {
                  ...nextDetails,
                  aheadCommits: [...nextDetails.aheadCommits, ...result.commits],
                  aheadCommitsRemaining: result.remaining,
                }
              : kind === "behind"
                ? {
                    ...nextDetails,
                    behindCommits: [...nextDetails.behindCommits, ...result.commits],
                    behindCommitsRemaining: result.remaining,
                  }
                : kind === "compare-history"
                  ? {
                      ...nextDetails,
                      compareCommits: [...nextDetails.compareCommits, ...result.commits],
                      compareCommitsRemaining: result.remaining,
                    }
                  : {
                      ...nextDetails,
                      commits: [...nextDetails.commits, ...result.commits],
                      commitsRemaining: result.remaining,
                    };
          const next = new Map(current);
          next.set(detailsKey, merged);
          next.set(merged.fullRefName, merged);
          next.set(merged.name, merged);
          return next;
        });
      } catch (nextError) {
        if (!isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          return;
        }
        if (isSourceControlPanelCommandInterrupted(nextError)) return;
        setError(errorMessage(nextError));
      } finally {
        if (isLatestPanelDetailRequest(branchDetailRequestsRef.current, detailsKey, requestId)) {
          setLoadingBranchDetails((current) => {
            const next = new Set(current);
            next.delete(detailsKey);
            return next;
          });
        }
      }
    },
    [api, cwd],
  );

  const loadStashDetails = useCallback(
    async (stash: VcsPanelStash) => {
      const detailsKey = stashIdentityKey(stash);
      if (!api || stashDetailsByKey.has(detailsKey)) return;
      setLoadingStashDetails((current) => {
        const next = new Set(current);
        next.add(detailsKey);
        return next;
      });
      try {
        const details = await api.vcs.stashDetails({ cwd, stashRef: stash.refName });
        setStashDetailsByKey((current) => {
          const next = new Map(current);
          next.set(detailsKey, details);
          return next;
        });
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setLoadingStashDetails((current) => {
          const next = new Set(current);
          next.delete(detailsKey);
          return next;
        });
      }
    },
    [api, cwd, stashDetailsByKey],
  );

  const toggleStashTree = useCallback(
    (key: string, stash: VcsPanelStash) => {
      const expanding = !expandedTree.has(key);
      toggleTree(key);
      if (expanding) void loadStashDetails(stash);
    },
    [expandedTree, loadStashDetails, toggleTree],
  );

  const toggleTreeFromKeyboard = useCallback(
    (key: string, event: ReactKeyboardEvent<HTMLDivElement>, defaultExpanded = false) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleTree(key, defaultExpanded);
    },
    [toggleTree],
  );

  const startSectionResize = useCallback(
    (key: SectionKey, event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const openKeys = SECTION_ORDER.filter((sectionKey) => !collapsed.has(sectionKey));
      const index = openKeys.indexOf(key);
      if (index < 0 || openKeys.length < 2) return;
      const adjacentKey = openKeys[index + 1] ?? openKeys[index - 1];
      if (!adjacentKey) return;
      const direction = openKeys[index + 1] ? 1 : -1;
      const startY = event.clientY;
      const startCurrent = sectionWeights[key];
      const startAdjacent = sectionWeights[adjacentKey];
      const total = startCurrent + startAdjacent;
      const containerHeight = Math.max(containerRef.current?.clientHeight ?? 1, 1);
      const onMove = (moveEvent: MouseEvent) => {
        const deltaWeight = ((moveEvent.clientY - startY) / containerHeight) * total * direction;
        const nextCurrent = Math.min(
          total - MIN_SECTION_WEIGHT,
          Math.max(MIN_SECTION_WEIGHT, startCurrent + deltaWeight),
        );
        setSectionWeights((current) => ({
          ...current,
          [key]: nextCurrent,
          [adjacentKey]: total - nextCurrent,
        }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [collapsed, sectionWeights],
  );

  return {
    chooseCompareBase,
    isTreeExpanded,
    loadBranchDetails,
    loadMoreBranchCommits,
    loadStashDetails,
    startSectionResize,
    toggleBranchTree,
    toggleBranchTreeFromKeyboard,
    toggleSection,
    toggleStashTree,
    toggleTree,
    toggleTreeFromKeyboard,
  };
}
