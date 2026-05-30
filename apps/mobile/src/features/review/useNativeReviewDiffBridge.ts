import { useCallback, useMemo, useState } from "react";
import type { NativeSyntheticEvent } from "react-native";

import { type NativeReviewDiffHighlightScheme } from "../diffs/nativeReviewDiffHighlighter";
import {
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_STYLE,
  type NativeReviewDiffData,
} from "./nativeReviewDiffAdapter";
import { useNativeReviewDiffHighlighting } from "./useNativeReviewDiffHighlighting";

export function hashReviewDiffKey(diff: string | null | undefined): string {
  if (!diff) {
    return "empty";
  }

  let hash = 5381;
  for (let index = 0; index < diff.length; index += 1) {
    hash = (hash * 33) ^ diff.charCodeAt(index);
  }

  return `${diff.length}:${(hash >>> 0).toString(36)}`;
}

export function buildNativeReviewTokensResetKey(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly diff: string | null | undefined;
  readonly fileCount: number;
  readonly rowCount: number;
}): string {
  return [
    input.threadKey ?? "none",
    input.sectionId ?? "none",
    input.scheme,
    hashReviewDiffKey(input.diff),
    input.fileCount,
    input.rowCount,
  ].join(":");
}

export function useNativeReviewDiffBridge(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly diff: string | null | undefined;
  readonly data: NativeReviewDiffData;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly collapsedFileIds: ReadonlyArray<string>;
  readonly viewedFileIds: ReadonlyArray<string>;
  readonly selectedRowIds: ReadonlyArray<string>;
  readonly canHighlight: boolean;
}) {
  const {
    canHighlight,
    collapsedFileIds,
    data,
    diff,
    scheme,
    sectionId,
    selectedRowIds,
    threadKey,
    viewedFileIds,
  } = input;
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const theme = useMemo(() => createNativeReviewDiffTheme(scheme), [scheme]);
  const rowsJson = useMemo(() => JSON.stringify(data.rows), [data.rows]);
  const collapsedFileIdsJson = useMemo(() => JSON.stringify(collapsedFileIds), [collapsedFileIds]);
  const viewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const selectedRowIdsJson = useMemo(() => JSON.stringify(selectedRowIds), [selectedRowIds]);
  const collapsedCommentIdsJson = useMemo(
    () => JSON.stringify(Array.from(collapsedCommentIds)),
    [collapsedCommentIds],
  );
  const themeJson = useMemo(() => JSON.stringify(theme), [theme]);
  const styleJson = useMemo(() => JSON.stringify(NATIVE_REVIEW_DIFF_STYLE), []);
  const tokensResetKey = useMemo(
    () =>
      buildNativeReviewTokensResetKey({
        threadKey,
        sectionId,
        scheme,
        diff,
        fileCount: data.files.length,
        rowCount: data.rows.length,
      }),
    [data.files.length, data.rows.length, diff, scheme, sectionId, threadKey],
  );
  const { tokensPatchJson, updateVisibleRange } = useNativeReviewDiffHighlighting({
    files: data.files,
    rows: data.rows,
    scheme,
    resetKey: tokensResetKey,
    enabled: canHighlight,
  });

  const onDebug = useCallback(
    (event: NativeSyntheticEvent<Record<string, unknown>>) => {
      const payload = event.nativeEvent;
      const message = payload.message;
      if (
        (message === "draw-metrics" || message === "visible-range") &&
        typeof payload.firstRowIndex === "number" &&
        typeof payload.lastRowIndex === "number"
      ) {
        updateVisibleRange({
          firstRowIndex: payload.firstRowIndex,
          lastRowIndex: payload.lastRowIndex,
        });
      }
    },
    [updateVisibleRange],
  );

  const onToggleComment = useCallback(
    (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => {
      const { commentId } = event.nativeEvent;
      if (!commentId) {
        return;
      }

      setCollapsedCommentIds((current) => {
        const next = new Set(current);
        if (next.has(commentId)) {
          next.delete(commentId);
        } else {
          next.add(commentId);
        }
        return next;
      });
    },
    [],
  );

  return {
    theme,
    rowsJson,
    collapsedFileIdsJson,
    collapsedCommentIdsJson,
    viewedFileIdsJson,
    selectedRowIdsJson,
    themeJson,
    styleJson,
    tokensPatchJson,
    tokensResetKey,
    onDebug,
    onToggleComment,
  };
}
