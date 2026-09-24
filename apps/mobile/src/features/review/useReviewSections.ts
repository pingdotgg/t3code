import { useCallback, useEffect, useMemo, useState } from "react";
import * as DateTime from "effect/DateTime";

import type {
  CheckpointDiffPage,
  EnvironmentId,
  OrchestrationCheckpointSummary,
  ThreadId,
} from "@t3tools/contracts";

import { orchestrationEnvironment } from "../../state/orchestration";
import {
  loadPagedReviewCommentSelection,
  reviewDiffWindowStart,
  retainReviewDiffWindows,
  mergeReviewDiffWindows,
} from "./pagedReviewDiff";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const selectedThread = useSelectedThreadDetail();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const diffPreview = useEnvironmentQuery(
    enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.data) {
      setReviewGitSections(reviewCache.threadKey, diffPreview.data.sources);
    }
  }, [diffPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, OrchestrationCheckpointSummary>,
    [readyCheckpoints],
  );
  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: diffPreview.data?.sources ?? reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
        loadingGitSections: diffPreview.isPending,
      }),
    [
      diffPreview.isPending,
      diffPreview.data?.sources,
      loadingTurnIds,
      readyCheckpoints,
      reviewCache.gitSections,
      reviewCache.turnDiffById,
    ],
  );
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (selectedSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[selectedSection.id] ?? activeCheckpoint;
  }
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const turnScope = `${environmentId}:${threadId}:${activeSectionId}`;
  const [window, setWindow] = useState({ scope: turnScope, start: 0 });
  const windowStart = window.scope === turnScope ? window.start : 0;
  const activeTurnDiff = useEnvironmentQuery(
    enabled && environmentId && threadId && activeCheckpoint && selectedSection?.kind === "turn"
      ? orchestrationEnvironment.turnDiffPage({
          environmentId,
          input: {
            threadId,
            fromTurnCount: Math.max(0, activeCheckpoint.checkpointTurnCount - 1),
            toTurnCount: activeCheckpoint.checkpointTurnCount,
            ignoreWhitespace: false,
            page: { start: windowStart },
          },
        })
      : null,
  );
  // Keep the current window visible while the next one arrives, without retaining
  // every visited page in the per-thread full-patch cache.
  const [previousWindow, setPreviousWindow] = useState({
    scope: turnScope,
    data: activeTurnDiff.data,
    pages: activeTurnDiff.data?.page
      ? [activeTurnDiff.data.page]
      : ([] as ReadonlyArray<CheckpointDiffPage>),
  });
  if (
    previousWindow.scope !== turnScope ||
    (activeTurnDiff.data && activeTurnDiff.data !== previousWindow.data)
  ) {
    setPreviousWindow({
      scope: turnScope,
      data: activeTurnDiff.data,
      pages: activeTurnDiff.data?.page
        ? retainReviewDiffWindows(
            previousWindow.scope === turnScope ? previousWindow.pages : [],
            activeTurnDiff.data.page,
          )
        : [],
    });
  }
  const turnData =
    activeTurnDiff.data ?? (previousWindow.scope === turnScope ? previousWindow.data : null);
  const mergedPage = useMemo(
    () => mergeReviewDiffWindows(previousWindow.scope === turnScope ? previousWindow.pages : []),
    [previousWindow, turnScope],
  );
  const resolvedSelectedSection = useMemo(
    () =>
      selectedSection?.kind === "turn" && turnData
        ? {
            ...selectedSection,
            diff: turnData.diff,
            ...(mergedPage ? { page: mergedPage } : {}),
            isLoading: false,
          }
        : selectedSection,
    [selectedSection, turnData, mergedPage],
  );
  const loadTurnDiffRow = useCallback(
    (row: number) => {
      const start = reviewDiffWindowStart(row);
      if (
        previousWindow.scope === turnScope &&
        previousWindow.pages.some((page) => page.start === start)
      )
        return;
      setWindow((current) =>
        current.scope === turnScope && current.start === start
          ? current
          : { scope: turnScope, start },
      );
    },
    [turnScope, setWindow, previousWindow],
  );
  const loadTurnDiffRange = useCallback(
    async (start: number, end: number, signal: AbortSignal) => {
      if (!environmentId || !threadId || !activeCheckpoint || !turnData?.page) return null;
      try {
        return await loadPagedReviewCommentSelection({
          start,
          end,
          revision: turnData.page.revision,
          fetchPage: async (start) => {
            const result = await executeAtomQuery(
              appAtomRegistry,
              orchestrationEnvironment.turnDiffPage({
                environmentId,
                input: {
                  threadId,
                  fromTurnCount: Math.max(0, activeCheckpoint.checkpointTurnCount - 1),
                  toTurnCount: activeCheckpoint.checkpointTurnCount,
                  ignoreWhitespace: false,
                  page: { start },
                },
              }),
              { signal },
            );
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            if (!result.value.page)
              throw new Error("The server did not return the requested diff lines.");
            return result.value.page;
          },
        });
      } catch (error) {
        if (!signal.aborted && reviewCache.threadKey) {
          setReviewAsyncError(
            reviewCache.threadKey,
            error instanceof Error ? error.message : "Could not load the selected diff lines.",
          );
        }
        return null;
      }
    },
    [environmentId, threadId, activeCheckpoint, turnData, reviewCache.threadKey],
  );

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  }, [activeTurnDiff, diffPreview, enabled, selectedSection?.kind]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    error: diffPreview.error ?? activeTurnDiff.error ?? reviewCache.asyncState.error,
    isSelectedSectionPending:
      selectedSection?.kind === "turn"
        ? activeTurnDiff.isPending && !turnData
        : diffPreview.isPending,
    loadingGitDiffs: diffPreview.isPending,
    diffPreviewRevision: diffPreview.data
      ? DateTime.formatIso(diffPreview.data.generatedAt)
      : undefined,
    loadingTurnIds,
    reviewSections,
    selectedSection: resolvedSelectedSection,
    loadTurnDiffRow,
    loadTurnDiffRange,
    refreshSelectedSection,
    selectSection,
  };
}
