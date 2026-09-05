import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  highlightNativeReviewDiffVisibleRows,
  type NativeReviewDiffHighlightEngine,
  type NativeReviewDiffHighlightScheme,
} from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import { computeVisibleNativeReviewWordDiffRanges } from "./nativeReviewWordDiffs";

interface NativeReviewVisibleRange {
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
}

interface NativeReviewWordDiffPatch {
  readonly resetKey: string;
  readonly wordDiffRangesByRowId: Awaited<
    ReturnType<typeof computeVisibleNativeReviewWordDiffRanges>
  >["rangesByRowId"];
}

function createEmptyTokenPatch(resetKey: string): string {
  return JSON.stringify({ resetKey, tokensByRowId: {} });
}

function isReviewDiffDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewDiffDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewDiffDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-sheet] ${message}`, details);
    return;
  }

  console.log(`[review-sheet] ${message}`);
}

export function useNativeReviewDiffHighlighting(input: {
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly scheme: NativeReviewDiffHighlightScheme;
  readonly resetKey: string;
  readonly contentResetKey: string;
  readonly enabled: boolean;
  readonly collapsedFileIds: ReadonlyArray<string>;
}) {
  const { collapsedFileIds, contentResetKey, enabled, files, resetKey, rows, scheme } = input;
  const highlightedRowIdsRef = useRef<Set<string>>(new Set());
  const wordHighlightedRowIdsRef = useRef<Set<string>>(new Set());
  const contentResetKeyRef = useRef(contentResetKey);
  const visibleRangeRef = useRef<NativeReviewVisibleRange>({
    firstRowIndex: 0,
    lastRowIndex: 80,
  });
  const visibleChunkIndexRef = useRef(0);
  const [tokensPatchJson, setTokensPatchJson] = useState(() => createEmptyTokenPatch(resetKey));
  const [wordDiffRangesPatch, setWordDiffRangesPatch] = useState<NativeReviewWordDiffPatch>(() => ({
    resetKey,
    wordDiffRangesByRowId: {},
  }));
  const wordDiffRangesPatchJson = useMemo(
    () => JSON.stringify(wordDiffRangesPatch),
    [wordDiffRangesPatch],
  );
  const [visibleHighlightRequest, setVisibleHighlightRequest] = useState(0);

  useEffect(() => {
    highlightedRowIdsRef.current = new Set();
    wordHighlightedRowIdsRef.current = new Set();
    visibleChunkIndexRef.current = 0;
    if (contentResetKeyRef.current !== contentResetKey) {
      contentResetKeyRef.current = contentResetKey;
      visibleRangeRef.current = { firstRowIndex: 0, lastRowIndex: 80 };
    }
    setTokensPatchJson(createEmptyTokenPatch(resetKey));
    setWordDiffRangesPatch({ resetKey, wordDiffRangesByRowId: {} });
    if (enabled && rows.length > 0) {
      setVisibleHighlightRequest((request) => request + 1);
    }
  }, [contentResetKey, enabled, resetKey, rows.length]);

  useEffect(() => {
    if (!enabled || rows.length === 0) {
      return;
    }

    const abortController = new AbortController();
    const requestRange = visibleRangeRef.current;
    const engine: NativeReviewDiffHighlightEngine = "native";

    void (async () => {
      try {
        const result = await highlightNativeReviewDiffVisibleRows({
          files,
          rows,
          scheme,
          engine,
          firstRowIndex: requestRange.firstRowIndex,
          lastRowIndex: requestRange.lastRowIndex,
          alreadyHighlightedRowIds: highlightedRowIdsRef.current,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted || result.rowCount === 0) {
          return;
        }

        for (const rowId of Object.keys(result.tokensByRowId)) {
          highlightedRowIdsRef.current.add(rowId);
        }

        const chunkIndex = visibleChunkIndexRef.current;
        visibleChunkIndexRef.current += 1;
        setTokensPatchJson(
          JSON.stringify({
            resetKey,
            chunkIndex,
            fileId: "visible",
            filePath: "visible rows",
            language: "diff",
            lineCount: result.rowCount,
            durationMs: result.durationMs,
            tokensByRowId: result.tokensByRowId,
          }),
        );
      } catch (error) {
        if (!abortController.signal.aborted) {
          logReviewDiffDiagnostic("native visible highlight failed", {
            error,
            resetKey,
            scheme,
            firstRowIndex: requestRange.firstRowIndex,
            lastRowIndex: requestRange.lastRowIndex,
          });
        }
      }
    })();

    return () => abortController.abort();
  }, [enabled, files, resetKey, rows, scheme, visibleHighlightRequest]);

  // Word ranges do not depend on the syntax engine. A syntax failure must not hide them.
  useEffect(() => {
    if (!enabled || rows.length === 0) return;
    const abortController = new AbortController();
    const requestRange = visibleRangeRef.current;
    void computeVisibleNativeReviewWordDiffRanges({
      rows,
      firstRowIndex: requestRange.firstRowIndex,
      lastRowIndex: requestRange.lastRowIndex,
      collapsedFileIds: new Set(collapsedFileIds),
      alreadyHighlightedRowIds: wordHighlightedRowIdsRef.current,
      signal: abortController.signal,
    })
      .then((result) => {
        if (abortController.signal.aborted || result.pairCount === 0) return;
        setWordDiffRangesPatch({ resetKey, wordDiffRangesByRowId: result.rangesByRowId });
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          logReviewDiffDiagnostic("native visible word diff failed", { error, resetKey });
        }
      });
    return () => abortController.abort();
  }, [collapsedFileIds, enabled, resetKey, rows, visibleHighlightRequest]);

  // A newer render can replace a patch before its native dispatch frame runs.
  const onWordDiffRangesPatchSent = useCallback(() => {
    if (wordDiffRangesPatch.resetKey !== resetKey) return;
    for (const rowId of Object.keys(wordDiffRangesPatch.wordDiffRangesByRowId)) {
      wordHighlightedRowIdsRef.current.add(rowId);
    }
  }, [resetKey, wordDiffRangesPatch]);

  const updateVisibleRange = useCallback((nextRange: NativeReviewVisibleRange) => {
    const previousRange = visibleRangeRef.current;
    const movedRows =
      Math.abs(nextRange.firstRowIndex - previousRange.firstRowIndex) +
      Math.abs(nextRange.lastRowIndex - previousRange.lastRowIndex);

    visibleRangeRef.current = nextRange;
    if (movedRows >= 20) {
      setVisibleHighlightRequest((request) => request + 1);
    }
  }, []);

  return {
    tokensPatchJson,
    wordDiffRangesPatchJson,
    onWordDiffRangesPatchSent,
    updateVisibleRange,
  };
}
