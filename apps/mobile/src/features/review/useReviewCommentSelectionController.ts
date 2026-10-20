import { useCallback, useEffect, useMemo } from "react";
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
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { ReviewSectionItem } from "./reviewModel";

export function useReviewCommentSelectionController(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly selectedSection: ReviewSectionItem | null;
  readonly nativeReviewDiffData: NativeReviewDiffData;
}) {
  const { environmentId, nativeReviewDiffData, selectedSection, threadId } = input;
  const navigation = useNavigation();
  const activeCommentTarget = useReviewCommentTarget();

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
    if (activeCommentTarget && activeCommentTarget.sectionTitle === selectedSection?.title) {
      return pipe(
        getSelectedReviewCommentLines(activeCommentTarget),
        Arr.filterMap((line) => {
          const rowId = nativeReviewDiffData.rowIdByCommentLineId.get(line.id);
          return rowId ? Result.succeed(rowId) : Result.failVoid;
        }),
      );
    }

    return [];
  }, [activeCommentTarget, nativeReviewDiffData.rowIdByCommentLineId, selectedSection?.title]);

  const selectionAction = useMemo(() => {
    if (activeCommentTarget && activeCommentTarget.sectionTitle === selectedSection?.title) {
      return {
        title: `Comment on ${formatReviewSelectedRangeLabel(activeCommentTarget)}`,
        onOpenComment: openReviewCommentSheet,
      };
    }

    return null;
  }, [activeCommentTarget, openReviewCommentSheet, selectedSection?.title]);

  useEffect(() => {
    clearReviewCommentTarget();
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- A new section invalidates the shared line selection.
  }, [selectedSection?.id]);

  const onPressLine = useCallback(
    (
      event: NativeSyntheticEvent<{
        readonly rowId?: string;
        readonly gesture?: "tap" | "longPress";
      }>,
    ) => {
      if (!selectedSection) {
        return;
      }

      const { rowId } = event.nativeEvent;
      if (!rowId) {
        return;
      }

      const target = nativeReviewDiffData.commentTargetsByRowId.get(rowId);
      if (!target) {
        return;
      }

      setReviewCommentTarget({
        sectionTitle: selectedSection.title,
        sectionId: selectedSection.id,
        filePath: target.filePath,
        lines: target.lines,
        startIndex: target.lineIndex,
        endIndex: target.lineIndex,
      });
    },
    [nativeReviewDiffData.commentTargetsByRowId, selectedSection],
  );

  const onSelectLineRange = useCallback(
    (event: NativeSyntheticEvent<{ readonly startRowId: string; readonly endRowId: string }>) => {
      if (!selectedSection) return;
      const first = nativeReviewDiffData.commentTargetsByRowId.get(event.nativeEvent.startRowId);
      const last = nativeReviewDiffData.commentTargetsByRowId.get(event.nativeEvent.endRowId);
      if (!first || !last || first.filePath !== last.filePath) return;
      setReviewCommentTarget(
        buildReviewCommentTarget(
          {
            sectionTitle: selectedSection.title,
            sectionId: selectedSection.id,
            filePath: first.filePath,
            lines: first.lines,
          },
          first.lineIndex,
          last.lineIndex,
        ),
      );
    },
    [nativeReviewDiffData.commentTargetsByRowId, selectedSection],
  );

  const clearSelection = useCallback(() => {
    clearReviewCommentTarget();
  }, []);

  return {
    selectedRowIds,
    selectionAction,
    onPressLine,
    onSelectLineRange,
    clearSelection,
  };
}
