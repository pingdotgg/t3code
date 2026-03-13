import { type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs";
import { type FileDiffMetadata } from "@pierre/diffs/react";
import { type ThreadId, type TurnId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffContextCommentSide,
  type DiffContextCommentDraft,
} from "../lib/diffContextComments";
import { randomUUID } from "../lib/utils";

export type DiffCommentAnnotationMetadata =
  | {
      kind: "draft-comment";
      filePath: string;
      lineStart: number;
      lineEnd: number;
    }
  | {
      kind: "saved-comment";
      commentId: string;
      filePath: string;
      lineStart: number;
      lineEnd: number;
      isEditing: boolean;
    };

export type DiffCommentSelection = {
  file: FileDiffMetadata;
  fileKey: string;
  range: SelectedLineRange;
};

const EMPTY_PENDING_DIFF_CONTEXT_COMMENTS: readonly DiffContextCommentDraft[] = [];

function normalizeDiffPath(raw: string | null | undefined): string {
  if (!raw) {
    return "";
  }
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return normalizeDiffPath(fileDiff.name ?? fileDiff.prevName);
}

export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

export function buildFileKeyByPathIndex(
  renderableFiles: ReadonlyArray<FileDiffMetadata>,
): Map<string, string> {
  const fileKeyByPath = new Map<string, string>();

  for (const fileDiff of renderableFiles) {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const candidatePaths = [normalizeDiffPath(fileDiff.prevName), normalizeDiffPath(fileDiff.name)];

    for (const filePath of candidatePaths) {
      if (!filePath) {
        continue;
      }
      fileKeyByPath.set(filePath, fileKey);
    }
  }

  return fileKeyByPath;
}

function toNormalizedLineRange(range: SelectedLineRange): SelectedLineRange {
  if (range.start <= range.end) {
    return range;
  }

  return {
    start: range.end,
    end: range.start,
    ...((range.endSide ?? range.side) ? { side: range.endSide ?? range.side } : {}),
    ...(range.endSide ? { endSide: range.side } : {}),
  };
}

function toLineRange(range: SelectedLineRange): { start: number; end: number } {
  const normalizedRange = toNormalizedLineRange(range);
  return {
    start: normalizedRange.start,
    end: normalizedRange.end,
  };
}

export function areSelectedLineRangesEqual(
  left: SelectedLineRange | null,
  right: SelectedLineRange | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  const normalizedLeft = toNormalizedLineRange(left);
  const normalizedRight = toNormalizedLineRange(right);
  return (
    normalizedLeft.start === normalizedRight.start &&
    normalizedLeft.end === normalizedRight.end &&
    normalizedLeft.side === normalizedRight.side &&
    normalizedLeft.endSide === normalizedRight.endSide
  );
}

function resolveCommentFilePath(
  fileDiff: FileDiffMetadata,
  side: DiffContextCommentSide,
): string | null {
  return normalizeDiffPath(
    side === "deletions"
      ? (fileDiff.prevName ?? fileDiff.name)
      : (fileDiff.name ?? fileDiff.prevName),
  );
}

export function useDiffContextCommentDrafts(args: {
  activeThreadId: ThreadId | null;
  selectedTurnId: TurnId | null;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
}) {
  const { activeThreadId, selectedTurnId, renderableFiles } = args;
  const addDiffContextComment = useComposerDraftStore((store) => store.addDiffContextComment);
  const updateDiffContextComment = useComposerDraftStore((store) => store.updateDiffContextComment);
  const removeDiffContextComment = useComposerDraftStore((store) => store.removeDiffContextComment);
  const pendingDiffContextComments = useComposerDraftStore((state) =>
    activeThreadId
      ? (state.draftsByThreadId[activeThreadId]?.diffContextComments ??
        EMPTY_PENDING_DIFF_CONTEXT_COMMENTS)
      : EMPTY_PENDING_DIFF_CONTEXT_COMMENTS,
  );
  const [manualCommentSelection, setManualCommentSelection] = useState<DiffCommentSelection | null>(
    null,
  );
  const [manualCommentBody, setManualCommentBody] = useState("");
  const [manualCommentError, setManualCommentError] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [editingCommentError, setEditingCommentError] = useState("");
  const suppressLineSelectionUntilRef = useRef(0);

  const visiblePendingDiffContextComments = useMemo(
    () => pendingDiffContextComments.filter((comment) => comment.turnId === selectedTurnId),
    [pendingDiffContextComments, selectedTurnId],
  );
  const selectedCommentRange = manualCommentSelection?.range ?? null;
  const selectedCommentLineRange = useMemo(
    () => (selectedCommentRange ? toLineRange(selectedCommentRange) : null),
    [selectedCommentRange],
  );
  const selectedCommentSide = (selectedCommentRange?.side ?? "additions") as DiffContextCommentSide;

  const lineAnnotationsByFileKey = useMemo<
    Record<string, DiffLineAnnotation<DiffCommentAnnotationMetadata>[]>
  >(() => {
    const annotationsByFileKey: Record<
      string,
      DiffLineAnnotation<DiffCommentAnnotationMetadata>[]
    > = {};
    const fileKeyByPath = buildFileKeyByPathIndex(renderableFiles);

    for (const comment of visiblePendingDiffContextComments) {
      const fileKey = fileKeyByPath.get(comment.filePath);
      if (!fileKey) {
        continue;
      }

      const annotations = annotationsByFileKey[fileKey] ?? [];
      annotations.push({
        side: comment.side,
        lineNumber: comment.lineEnd,
        metadata: {
          kind: "saved-comment",
          commentId: comment.id,
          filePath: comment.filePath,
          lineStart: comment.lineStart,
          lineEnd: comment.lineEnd,
          isEditing: editingCommentId === comment.id,
        },
      });
      annotationsByFileKey[fileKey] = annotations;
    }

    if (!manualCommentSelection || !selectedCommentLineRange) {
      return annotationsByFileKey;
    }

    const filePath = resolveCommentFilePath(manualCommentSelection.file, selectedCommentSide);
    if (!filePath) {
      return annotationsByFileKey;
    }

    const annotations = annotationsByFileKey[manualCommentSelection.fileKey] ?? [];
    annotations.push({
      side: selectedCommentSide,
      lineNumber: selectedCommentLineRange.end,
      metadata: {
        kind: "draft-comment",
        filePath,
        lineStart: selectedCommentLineRange.start,
        lineEnd: selectedCommentLineRange.end,
      },
    });
    annotationsByFileKey[manualCommentSelection.fileKey] = annotations;

    return annotationsByFileKey;
  }, [
    editingCommentId,
    manualCommentSelection,
    renderableFiles,
    selectedCommentLineRange,
    selectedCommentSide,
    visiblePendingDiffContextComments,
  ]);

  const selectedLinesForFileKey = useMemo(
    () =>
      manualCommentSelection
        ? {
            fileKey: manualCommentSelection.fileKey,
            range: manualCommentSelection.range,
          }
        : null,
    [manualCommentSelection],
  );

  useEffect(() => {
    setManualCommentSelection(null);
    setManualCommentBody("");
    setManualCommentError("");
    setEditingCommentId(null);
    setEditingCommentBody("");
    setEditingCommentError("");
  }, [activeThreadId, selectedTurnId]);

  useEffect(() => {
    if (!editingCommentId) {
      return;
    }

    const stillVisible = visiblePendingDiffContextComments.some(
      (comment) => comment.id === editingCommentId,
    );
    if (stillVisible) {
      return;
    }

    setEditingCommentId(null);
    setEditingCommentBody("");
    setEditingCommentError("");
  }, [editingCommentId, visiblePendingDiffContextComments]);

  const handleManualCommentSelectionChange = useCallback(
    (input: { file: FileDiffMetadata; fileKey: string; range: SelectedLineRange | null }) => {
      if (input.range && Date.now() < suppressLineSelectionUntilRef.current) {
        return;
      }

      if (!input.range) {
        setManualCommentSelection((current) => {
          if (current?.fileKey !== input.fileKey) {
            return current;
          }
          return null;
        });
        setManualCommentError("");
        return;
      }

      setEditingCommentId(null);
      setEditingCommentBody("");
      setEditingCommentError("");

      const nextRange = toNormalizedLineRange(input.range);
      setManualCommentSelection((current) => {
        if (
          current &&
          current.fileKey === input.fileKey &&
          areSelectedLineRangesEqual(current.range, nextRange)
        ) {
          return current;
        }

        return {
          file: input.file,
          fileKey: input.fileKey,
          range: nextRange,
        };
      });
      setManualCommentError("");
    },
    [],
  );

  const clearManualCommentSelection = useCallback(() => {
    suppressLineSelectionUntilRef.current = Date.now() + 500;
    setManualCommentSelection(null);
    setManualCommentBody("");
    setManualCommentError("");
  }, []);

  const cancelEditingComment = useCallback(() => {
    setEditingCommentId(null);
    setEditingCommentBody("");
    setEditingCommentError("");
  }, []);

  const beginEditingComment = useCallback((comment: DiffContextCommentDraft) => {
    setManualCommentSelection(null);
    setManualCommentBody("");
    setManualCommentError("");
    setEditingCommentId(comment.id);
    setEditingCommentBody(comment.body);
    setEditingCommentError("");
  }, []);

  const submitManualComment = useCallback(() => {
    if (!activeThreadId || !manualCommentSelection || !selectedCommentLineRange) {
      setManualCommentError("Select at least one line before sending.");
      return;
    }

    const commentBody = manualCommentBody.trim();
    if (commentBody.length === 0) {
      setManualCommentError("Comment text is required.");
      return;
    }

    const endSide = manualCommentSelection.range.endSide;
    if (endSide && endSide !== selectedCommentSide) {
      setManualCommentError("Selection crosses additions and deletions. Select one side only.");
      return;
    }

    const filePath = resolveCommentFilePath(manualCommentSelection.file, selectedCommentSide);
    if (!filePath) {
      setManualCommentError("Unable to resolve the selected file path.");
      return;
    }

    addDiffContextComment(activeThreadId, {
      id: randomUUID(),
      threadId: activeThreadId,
      turnId: selectedTurnId,
      filePath,
      lineStart: selectedCommentLineRange.start,
      lineEnd: selectedCommentLineRange.end,
      side: selectedCommentSide,
      body: commentBody,
      createdAt: new Date().toISOString(),
    });
    setEditingCommentId(null);
    setEditingCommentBody("");
    setEditingCommentError("");
    clearManualCommentSelection();
  }, [
    activeThreadId,
    addDiffContextComment,
    clearManualCommentSelection,
    manualCommentBody,
    manualCommentSelection,
    selectedCommentLineRange,
    selectedCommentSide,
    selectedTurnId,
  ]);

  const saveEditingComment = useCallback(() => {
    if (!activeThreadId || !editingCommentId) {
      return;
    }

    const commentBody = editingCommentBody.trim();
    if (commentBody.length === 0) {
      setEditingCommentError("Comment text is required.");
      return;
    }

    updateDiffContextComment(activeThreadId, editingCommentId, {
      body: commentBody,
    });
    setEditingCommentId(null);
    setEditingCommentBody("");
    setEditingCommentError("");
  }, [activeThreadId, editingCommentBody, editingCommentId, updateDiffContextComment]);

  const deleteEditingComment = useCallback(() => {
    if (!activeThreadId || !editingCommentId) {
      return;
    }

    removeDiffContextComment(activeThreadId, editingCommentId);
    cancelEditingComment();
  }, [activeThreadId, cancelEditingComment, editingCommentId, removeDiffContextComment]);

  return {
    editingCommentBody,
    editingCommentError,
    lineAnnotationsByFileKey,
    manualCommentBody,
    manualCommentError,
    selectedLinesForFileKey,
    visiblePendingDiffContextComments,
    beginEditingComment,
    cancelEditingComment,
    clearManualCommentSelection,
    deleteEditingComment,
    handleManualCommentSelectionChange,
    saveEditingComment,
    setEditingCommentBody,
    setManualCommentBody,
    submitManualComment,
  };
}
