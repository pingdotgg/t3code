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
  formatReviewSelectedRangeLabel,
  getSelectedReviewCommentLines,
  nextReviewSheetId,
  reviewCommentSelectionScope,
  setReviewCommentTarget,
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

  const openReviewCommentSheet = () => {
    if (!environmentId || !threadId) {
      return;
    }

    navigation.navigate("ThreadReviewComment", {
      environmentId,
      threadId,
    });
  };

  const selectedRowIds =
    activeCommentTarget !== null
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

  const selectionAction =
    activeCommentTarget !== null
      ? {
          title: `Comment on ${formatReviewSelectedRangeLabel(activeCommentTarget)}`,
          onOpenComment: openReviewCommentSheet,
        }
      : pendingRange
        ? { title: "Select range end", onOpenComment: null }
        : null;

  const onPressLine = (event: NativeSyntheticEvent<{ readonly rowId?: string }>) => {
    if (!selectedSection || scope === null) return;
    const rowId = event.nativeEvent.rowId;
    const target = rowId ? nativeReviewDiffData.commentTargetsByRowId.get(rowId) : undefined;
    if (!target) return;
    setReviewCommentTarget(scope, {
      sectionTitle: selectedSection.title,
      sectionId: selectedSection.id,
      filePath: target.filePath,
      lines: target.lines,
      startIndex: target.lineIndex,
      endIndex: target.lineIndex,
    });
  };
  const onSelectLineRange = (
    event: NativeSyntheticEvent<{ readonly startRowId: string; readonly endRowId: string }>,
  ) => {
    if (!selectedSection || scope === null) return;
    const first = nativeReviewDiffData.commentTargetsByRowId.get(event.nativeEvent.startRowId);
    const last = nativeReviewDiffData.commentTargetsByRowId.get(event.nativeEvent.endRowId);
    if (!first || !last || first.filePath !== last.filePath) return;
    setReviewCommentTarget(
      scope,
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
  };

  return {
    selectedRowIds,
    selectionAction,
    onPressLine,
    onSelectLineRange,
    clearSelection: clearReviewCommentTarget,
  };
}
