import { useEffect, useRef, useState } from "react";

import type { HighlightScheme } from "../../lib/highlights";
import { highlightNativeReviewDiffVisibleRows } from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";

import {
  createReviewDiffHighlightScheduler,
  type NativeReviewVisibleRange,
} from "./reviewDiffHighlightScheduler";

function createEmptyTokenPatch(resetKey: string): string {
  return JSON.stringify({ resetKey, tokensByRowId: {} });
}

export function useNativeReviewDiffHighlighting(input: {
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly scheme: HighlightScheme;
  readonly resetKey: string;
  readonly enabled: boolean;
}) {
  const { enabled, files, resetKey, rows, scheme } = input;
  const highlightedRowIdsRef = useRef<Set<string>>(new Set());
  const [visibleRange, setVisibleRange] = useState<NativeReviewVisibleRange>({
    firstRowIndex: 0,
    lastRowIndex: 80,
  });
  const visibleChunkIndexRef = useRef(0);
  const [tokensPatchJson, setTokensPatchJson] = useState(() => createEmptyTokenPatch(resetKey));
  const [scheduler] = useState(() => createReviewDiffHighlightScheduler(setVisibleRange));

  useEffect(() => {
    scheduler.reset();
    highlightedRowIdsRef.current = new Set();
    visibleChunkIndexRef.current = 0;
    setVisibleRange({ firstRowIndex: 0, lastRowIndex: 80 });
    setTokensPatchJson(createEmptyTokenPatch(resetKey));
    return () => scheduler.cancel();
  }, [enabled, resetKey, rows.length, scheduler]);

  useEffect(() => {
    if (!enabled || rows.length === 0) {
      return;
    }

    const result = highlightNativeReviewDiffVisibleRows({
      files,
      rows,
      scheme,
      firstRowIndex: visibleRange.firstRowIndex,
      lastRowIndex: visibleRange.lastRowIndex,
      alreadyHighlightedRowIds: highlightedRowIdsRef.current,
    });
    if (result.rowCount === 0) return;

    for (const rowId of Object.keys(result.tokensByRowId)) {
      highlightedRowIdsRef.current.add(rowId);
    }

    const chunkIndex = visibleChunkIndexRef.current;
    visibleChunkIndexRef.current += 1;
    setTokensPatchJson(
      JSON.stringify({ resetKey, chunkIndex, tokensByRowId: result.tokensByRowId }),
    );
  }, [enabled, files, resetKey, rows, scheme, visibleRange]);

  return {
    tokensPatchJson,
    updateVisibleRange: scheduler.update,
  };
}
