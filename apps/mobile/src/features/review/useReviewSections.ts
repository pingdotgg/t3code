import { useCallback, useEffect, useMemo, useRef } from "react";

import type { EnvironmentId, OrchestrationCheckpointSummary, ThreadId } from "@t3tools/contracts";

import { getEnvironmentClient } from "../../state/environment-session-registry";
import { checkpointDiffManager, loadCheckpointDiff } from "../../state/use-checkpoint-diff";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useReviewDiffPreview } from "./reviewDiffPreviewState";
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
  setReviewTurnDiff,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const selectedThread = useSelectedThreadDetail();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const diffPreview = useReviewDiffPreview({ environmentId, cwd: selectedThreadCwd });
  const refreshDiffPreview = diffPreview.refresh;
  const { loadingTurnIds } = reviewCache.asyncState;
  const error = diffPreview.error ?? reviewCache.asyncState.error;
  const loadingGitDiffs = diffPreview.isPending;
  const turnDiffByIdRef = useRef(reviewCache.turnDiffById);

  useEffect(() => {
    turnDiffByIdRef.current = reviewCache.turnDiffById;
  }, [reviewCache.turnDiffById]);

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.data) {
      setReviewGitSections(reviewCache.threadKey, diffPreview.data.sources);
    }
  }, [diffPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );
  const checkpointBySectionId = useMemo(() => {
    return Object.fromEntries(
      readyCheckpoints.map((checkpoint) => [
        getReviewSectionIdForCheckpoint(checkpoint),
        checkpoint,
      ]),
    ) as Record<string, OrchestrationCheckpointSummary>;
  }, [readyCheckpoints]);
  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
        loadingGitSections: diffPreview.isPending,
      }),
    [
      diffPreview.isPending,
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
  const hasReviewSections = reviewSections.length > 0;
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  const loadTurnDiff = useCallback(
    async (checkpoint: OrchestrationCheckpointSummary, force = false) => {
      if (!environmentId || !threadId) {
        return;
      }

      const sectionId = getReviewSectionIdForCheckpoint(checkpoint);
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }

      if (!force && turnDiffByIdRef.current[sectionId] !== undefined) {
        return;
      }

      const target = {
        environmentId,
        threadId,
        fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
        toTurnCount: checkpoint.checkpointTurnCount,
        ignoreWhitespace: false,
        cacheScope: sectionId,
      };
      const cached = checkpointDiffManager.getSnapshot(target).data;
      if (!force && cached) {
        if (reviewCache.threadKey) {
          setReviewTurnDiff(reviewCache.threadKey, sectionId, cached.diff);
        }
        return;
      }

      if (!getEnvironmentClient(environmentId)) {
        if (reviewCache.threadKey) {
          setReviewAsyncError(reviewCache.threadKey, "Remote connection is not ready.");
        }
        return;
      }

      if (reviewCache.threadKey) {
        setReviewTurnDiffLoading(reviewCache.threadKey, sectionId, true);
        setReviewAsyncError(reviewCache.threadKey, null);
      }
      try {
        const result = await loadCheckpointDiff(target, { force });
        if (reviewCache.threadKey) {
          if (result) {
            setReviewTurnDiff(reviewCache.threadKey, sectionId, result.diff);
          }
        }
      } catch (cause) {
        if (reviewCache.threadKey) {
          setReviewAsyncError(
            reviewCache.threadKey,
            cause instanceof Error ? cause.message : "Failed to load turn diff.",
          );
        }
      } finally {
        if (reviewCache.threadKey) {
          setReviewTurnDiffLoading(reviewCache.threadKey, sectionId, false);
        }
      }
    },
    [environmentId, reviewCache.threadKey, threadId],
  );

  useEffect(() => {
    if (!hasReviewSections) {
      return;
    }

    if (reviewCache.threadKey && (!reviewCache.selectedSectionId || !selectedSectionIdExists)) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    hasReviewSections,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    selectedSectionIdExists,
  ]);

  const latestCheckpoint = readyCheckpoints[0] ?? null;
  const latestSectionId = latestCheckpoint
    ? getReviewSectionIdForCheckpoint(latestCheckpoint)
    : null;
  const latestTurnDiffLoaded = latestSectionId
    ? reviewCache.turnDiffById[latestSectionId] !== undefined
    : true;
  const latestTurnDiffLoading = latestSectionId ? loadingTurnIds[latestSectionId] === true : false;

  useEffect(() => {
    if (!latestCheckpoint || !latestSectionId || latestTurnDiffLoaded || latestTurnDiffLoading) {
      return;
    }

    void loadTurnDiff(latestCheckpoint);
  }, [
    latestCheckpoint,
    latestSectionId,
    latestTurnDiffLoaded,
    latestTurnDiffLoading,
    loadTurnDiff,
  ]);

  const selectedTurnCheckpoint =
    selectedSection?.kind === "turn" ? (checkpointBySectionId[selectedSection.id] ?? null) : null;
  const selectedTurnDiffMissing =
    selectedSection?.kind === "turn" && selectedSection.diff === null && selectedTurnCheckpoint;
  const selectedTurnDiffLoading =
    selectedSection?.kind === "turn" ? loadingTurnIds[selectedSection.id] === true : false;

  useEffect(() => {
    if (!selectedTurnDiffMissing || selectedTurnDiffLoading) {
      return;
    }

    void loadTurnDiff(selectedTurnDiffMissing);
  }, [loadTurnDiff, selectedTurnDiffLoading, selectedTurnDiffMissing]);

  const refreshSelectedSection = useCallback(async () => {
    if (!selectedSection) {
      return;
    }

    if (selectedSection.kind === "turn") {
      const checkpoint = checkpointBySectionId[selectedSection.id];
      if (checkpoint) {
        await loadTurnDiff(checkpoint, true);
      }
      return;
    }

    refreshDiffPreview();
  }, [checkpointBySectionId, loadTurnDiff, refreshDiffPreview, selectedSection]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    error,
    loadingGitDiffs,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}
