import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { useNavigation } from "@react-navigation/native";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Result from "effect/Result";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  formatReviewSelectedRangeLabel,
  getSelectedReviewCommentLines,
  setReviewCommentTarget,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import type {
  NativeReviewDiffData,
  NativeReviewDiffCommentTarget,
} from "./nativeReviewDiffAdapter";
import type { ReviewSectionItem, ReviewRenderableLineRow } from "./reviewModel";

interface PendingNativeCommentSelection extends NativeReviewDiffCommentTarget {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly rowId: string;
}

export function useReviewCommentSelectionController(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly selectedSection: ReviewSectionItem | null;
  readonly nativeReviewDiffData: NativeReviewDiffData;
  readonly loadCommentRange?: (
    start: number,
    end: number,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<ReviewRenderableLineRow> | null>;
}) {
  const { environmentId, nativeReviewDiffData, selectedSection, threadId, loadCommentRange } =
    input;
  const navigation = useNavigation();
  const rangeRequest = useRef<AbortController | null>(null);
  const activeCommentTarget = useReviewCommentTarget();
  const [pendingNativeCommentSelection, setPendingNativeCommentSelection] =
    useState<PendingNativeCommentSelection | null>(null);

  const openReviewCommentSheet = useCallback(() => {
    if (!environmentId || !threadId) {
      return;
    }

    navigation.navigate("ThreadReviewComment", {
      environmentId,
      threadId,
    });
  }, [environmentId, navigation, threadId]);

  const selectedRowIds = useMemo(() => {
    if (
      activeCommentTarget &&
      activeCommentTarget.sectionTitle === selectedSection?.title &&
      activeCommentTarget.startIndex !== activeCommentTarget.endIndex
    ) {
      return pipe(
        getSelectedReviewCommentLines(activeCommentTarget),
        Arr.filterMap((line) => {
          const rowId = nativeReviewDiffData.rowIdByCommentLineId.get(line.id);
          return rowId ? Result.succeed(rowId) : Result.failVoid;
        }),
      );
    }

    return pendingNativeCommentSelection ? [pendingNativeCommentSelection.rowId] : [];
  }, [
    activeCommentTarget,
    nativeReviewDiffData.rowIdByCommentLineId,
    pendingNativeCommentSelection,
    selectedSection?.title,
  ]);

  const selectionAction = useMemo(() => {
    if (
      activeCommentTarget &&
      activeCommentTarget.sectionTitle === selectedSection?.title &&
      activeCommentTarget.startIndex !== activeCommentTarget.endIndex
    ) {
      return {
        title: `Comment on ${formatReviewSelectedRangeLabel(activeCommentTarget)}`,
        onOpenComment: openReviewCommentSheet,
      };
    }

    if (
      pendingNativeCommentSelection &&
      pendingNativeCommentSelection.sectionTitle === selectedSection?.title
    ) {
      return {
        title: "Select range end",
        onOpenComment: null,
      };
    }

    return null;
  }, [
    activeCommentTarget,
    openReviewCommentSheet,
    pendingNativeCommentSelection,
    selectedSection?.title,
  ]);

  useEffect(() => {
    clearReviewCommentTarget();
    setPendingNativeCommentSelection(null);
    return () => rangeRequest.current?.abort();
  }, [selectedSection?.id]);

  useEffect(() => {
    if (activeCommentTarget === null) {
      setPendingNativeCommentSelection(null);
    }
  }, [activeCommentTarget]);

  const onPressLine = useCallback(
    async (
      event: NativeSyntheticEvent<{
        readonly rowId?: string;
        readonly gesture?: "tap" | "longPress";
      }>,
    ) => {
      if (!selectedSection) {
        return;
      }

      const { rowId, gesture } = event.nativeEvent;
      if (!rowId) {
        return;
      }

      const target = nativeReviewDiffData.commentTargetsByRowId.get(rowId);
      if (!target) {
        return;
      }
      rangeRequest.current?.abort();

      if (gesture === "longPress") {
        clearReviewCommentTarget();
        setPendingNativeCommentSelection({
          ...target,
          sectionId: selectedSection.id,
          sectionTitle: selectedSection.title,
          rowId,
        });
        return;
      }

      if (
        pendingNativeCommentSelection &&
        pendingNativeCommentSelection.sectionTitle === selectedSection.title &&
        pendingNativeCommentSelection.filePath === target.filePath
      ) {
        const anchor = pendingNativeCommentSelection.lines[pendingNativeCommentSelection.lineIndex];
        const endpoint = target.lines[target.lineIndex];
        if (anchor?.sourceRow !== undefined && endpoint?.sourceRow !== undefined) {
          const request = new AbortController();
          rangeRequest.current = request;
          const anchorIndex = target.lines.findIndex((line) => line.id === anchor.id);
          const cachedLines =
            anchorIndex >= 0
              ? target.lines.slice(
                  Math.min(anchorIndex, target.lineIndex),
                  Math.max(anchorIndex, target.lineIndex) + 1,
                )
              : [];
          const lines =
            anchor.sourceLineIndex !== undefined &&
            endpoint.sourceLineIndex !== undefined &&
            cachedLines.length === Math.abs(anchor.sourceLineIndex - endpoint.sourceLineIndex) + 1
              ? cachedLines
              : await loadCommentRange?.(anchor.sourceRow, endpoint.sourceRow, request.signal);
          if (!lines?.length || request.signal.aborted) return;
          setReviewCommentTarget(
            buildReviewCommentTarget(
              {
                sectionId: selectedSection.id,
                sectionTitle: selectedSection.title,
                filePath: target.filePath,
                lines,
              },
              0,
              lines.length - 1,
            ),
          );
          return;
        }
        setReviewCommentTarget(
          buildReviewCommentTarget(
            {
              sectionTitle: pendingNativeCommentSelection.sectionTitle,
              sectionId: pendingNativeCommentSelection.sectionId,
              filePath: pendingNativeCommentSelection.filePath,
              lines: pendingNativeCommentSelection.lines,
            },
            pendingNativeCommentSelection.lineIndex,
            target.lineIndex,
          ),
        );
        return;
      }

      setPendingNativeCommentSelection(null);
      setReviewCommentTarget({
        sectionTitle: selectedSection.title,
        sectionId: selectedSection.id,
        filePath: target.filePath,
        lines: target.lines,
        startIndex: target.lineIndex,
        endIndex: target.lineIndex,
      });
      openReviewCommentSheet();
    },
    [
      nativeReviewDiffData.commentTargetsByRowId,
      openReviewCommentSheet,
      pendingNativeCommentSelection,
      selectedSection,
      loadCommentRange,
    ],
  );

  const clearSelection = useCallback(() => {
    rangeRequest.current?.abort();
    clearReviewCommentTarget();
    setPendingNativeCommentSelection(null);
  }, []);

  return {
    selectedRowIds,
    selectionAction,
    onPressLine,
    clearSelection,
  };
}
