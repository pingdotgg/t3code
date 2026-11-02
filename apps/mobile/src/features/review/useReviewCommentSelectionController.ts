import { useState } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { useNavigation } from "@react-navigation/native";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Result from "effect/Result";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  completeReviewCommentRange,
  formatReviewSelectedRangeLabel,
  getSelectedReviewCommentLines,
  nextReviewSheetId,
  reviewCommentSelectionScope,
  setReviewCommentTarget,
  startReviewCommentRange,
  useReviewCommentSelection,
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
  const [sheetId] = useState(nextReviewSheetId);
  // Scoping the selection to this sheet, thread, section and diff drops it when the sheet
  // reopens, either changes, or a section comes back with different lines.
  const scope = reviewCommentSelectionScope(
    sheetId,
    environmentId && threadId ? scopedThreadKey(environmentId, threadId) : null,
    selectedSection === null
      ? null
      : {
          id: selectedSection.id,
          content: selectedSection.source?.diffHash ?? selectedSection.diff,
        },
  );
  const { target: activeCommentTarget, pending: pendingRange } = useReviewCommentSelection(scope);
  const hasRangeTarget =
    activeCommentTarget !== null && activeCommentTarget.startIndex !== activeCommentTarget.endIndex;

  const openReviewCommentSheet = () => {
    if (!environmentId || !threadId) {
      return;
    }

    navigation.navigate("ThreadReviewComment", {
      environmentId,
      threadId,
    });
  };

  const selectedRowIds = hasRangeTarget
    ? pipe(
        getSelectedReviewCommentLines(activeCommentTarget),
        Arr.filterMap((line) => {
          const rowId = nativeReviewDiffData.rowIdByCommentLineId.get(line.id);
          return rowId ? Result.succeed(rowId) : Result.failVoid;
        }),
      )
    : pendingRange
      ? [pendingRange.rowId]
      : [];

  const selectionAction = hasRangeTarget
    ? {
        title: `Comment on ${formatReviewSelectedRangeLabel(activeCommentTarget)}`,
        onOpenComment: openReviewCommentSheet,
      }
    : pendingRange
      ? { title: "Select range end", onOpenComment: null }
      : null;

  const onPressLine = (
    event: NativeSyntheticEvent<{
      readonly rowId?: string;
      readonly gesture?: "tap" | "longPress";
    }>,
  ) => {
    if (!selectedSection || scope === null) {
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

    if (gesture === "longPress") {
      startReviewCommentRange(scope, {
        sectionId: selectedSection.id,
        sectionTitle: selectedSection.title,
        filePath: target.filePath,
        lines: target.lines,
        lineIndex: target.lineIndex,
        rowId,
      });
      return;
    }

    if (pendingRange && pendingRange.filePath === target.filePath) {
      completeReviewCommentRange(
        scope,
        buildReviewCommentTarget(pendingRange, pendingRange.lineIndex, target.lineIndex),
      );
      return;
    }

    setReviewCommentTarget(scope, {
      sectionTitle: selectedSection.title,
      sectionId: selectedSection.id,
      filePath: target.filePath,
      lines: target.lines,
      startIndex: target.lineIndex,
      endIndex: target.lineIndex,
    });
    openReviewCommentSheet();
  };

  return {
    selectedRowIds,
    selectionAction,
    onPressLine,
    clearSelection: clearReviewCommentTarget,
  };
}
