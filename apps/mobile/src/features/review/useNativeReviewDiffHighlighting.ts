import type { HighlightScheme } from "../../lib/highlights";

import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  highlightNativeReviewDiffVisibleRows,
  type NativeReviewDiffHighlightChunk,
} from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import { diffHighlightTraceId, traceDiffHighlight } from "../diffs/nativeReviewDiffTrace";

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
  readonly collapsedFileIds: ReadonlySet<string>;
  readonly resetKey: string;
  readonly enabled: boolean;
}) {
  const { collapsedFileIds, enabled, files, resetKey, rows, scheme } = input;
  const highlightedRowIdsRef = useRef<Set<string>>(new Set());
  const viewportScope = `${enabled}:${resetKey}:${rows.length}`;
  const [viewport, setViewport] = useState<{
    scope: string;
    range: NativeReviewVisibleRange | null;
  }>(() => ({ scope: viewportScope, range: null }));
  const visibleChunkIndexRef = useRef(0);
  // Keep undelivered chunks, rather than repeatedly serializing every highlighted row.
  const pendingPatchesRef = useRef<
    Array<{ resetKey: string; chunkIndex: number; json: string; rowIds: string[] }>
  >([]);
  const [tokensPatchJson, setTokensPatchJson] = useState(() => createEmptyTokenPatch(resetKey));
  const [scheduler] = useState(() =>
    createReviewDiffHighlightScheduler((range) =>
      setViewport((current) => ({ ...current, range })),
    ),
  );

  // Effect on purpose: the native highlighter's token stream and the scheduler's timers must
  // reset with the diff the view shows, and be cancelled when it unmounts.
  useEffect(() => {
    traceDiffHighlight("viewport-reset", {
      reset: diffHighlightTraceId(resetKey),
      enabled,
      rows: rows.length,
    });
    const previousRange = scheduler.reset();
    highlightedRowIdsRef.current = new Set();
    pendingPatchesRef.current = [];
    // oxlint-disable-next-line react/set-state-in-effect -- Resetting the native highlighter clears the viewport and token-patch snapshots together.
    setViewport({ scope: viewportScope, range: null });
    setTokensPatchJson(createEmptyTokenPatch(resetKey));
    // A token reset need not produce another native range event. Reuse only an
    // observed viewport, with the same coalescing that lets a new jump replace it.
    if (previousRange) scheduler.update(previousRange);
    return () => scheduler.cancel();
  }, [enabled, resetKey, rows.length, scheduler, viewportScope]);

  // Effect on purpose: abortable async highlighting tied to the visible range's lifetime.
  useEffect(() => {
    if (!enabled || rows.length === 0 || !viewport.range || viewport.scope !== viewportScope) {
      return;
    }

    const abortController = new AbortController();
    const requestRange = viewport.range;
    const generation = diffHighlightTraceId(abortController);
    const reset = diffHighlightTraceId(resetKey);
    traceDiffHighlight("viewport-start", {
      generation,
      reset,
      first: requestRange.firstRowIndex,
      last: requestRange.lastRowIndex,
      pending: pendingPatchesRef.current.length,
    });

    const enqueueChunk = (result: NativeReviewDiffHighlightChunk) => {
      if (abortController.signal.aborted || result.rowCount === 0) return;
      const retryableRowIds = new Set(result.retryableRowIds);
      const rowIds = Object.keys(result.tokensByRowId);
      for (const rowId of rowIds) {
        if (!retryableRowIds.has(rowId)) highlightedRowIdsRef.current.add(rowId);
      }
      const chunkIndex = visibleChunkIndexRef.current++;
      const json = JSON.stringify({
        resetKey,
        chunkIndex,
        fileId: "visible",
        filePath: "visible rows",
        language: "diff",
        lineCount: result.rowCount,
        durationMs: result.durationMs,
        tokensByRowId: result.tokensByRowId,
      });
      pendingPatchesRef.current.push({ resetKey, chunkIndex, json, rowIds });
      traceDiffHighlight("patch-queued", {
        generation,
        reset,
        chunk: chunkIndex,
        rows: rowIds.length,
        pending: pendingPatchesRef.current.length,
      });
      if (pendingPatchesRef.current.length === 1) setTokensPatchJson(json);
    };

    void (async () => {
      // Deliver viewport tokens before offscreen source fetches can delay them.
      let retryableViewportRowIds: ReadonlyArray<string> = [];
      for (const overscanRows of [0, undefined]) {
        const deliveredRowIds = new Set<string>();
        const settled = await settlePromise(() =>
          highlightNativeReviewDiffVisibleRows({
            files,
            rows,
            scheme,
            collapsedFileIds,
            firstRowIndex: requestRange.firstRowIndex,
            lastRowIndex: requestRange.lastRowIndex,
            overscanRows,
            alreadyHighlightedRowIds:
              retryableViewportRowIds.length > 0
                ? new Set([...highlightedRowIdsRef.current, ...retryableViewportRowIds])
                : highlightedRowIdsRef.current,
            signal: abortController.signal,
            onChunk: (chunk) => {
              for (const rowId of Object.keys(chunk.tokensByRowId)) deliveredRowIds.add(rowId);
              enqueueChunk(chunk);
            },
          }),
        );
        if (abortController.signal.aborted) return;
        if (AsyncResult.isFailure(settled)) {
          console.warn("[review-sheet] native visible highlight failed", {
            error: squashAtomCommandFailure(settled),
            resetKey,
            scheme,
            collapsedFileIds,
            firstRowIndex: requestRange.firstRowIndex,
            lastRowIndex: requestRange.lastRowIndex,
          });
          return;
        }
        const result = settled.value;
        traceDiffHighlight("viewport-result", {
          generation,
          reset,
          overscan: overscanRows ?? 160,
          rows: result.rowCount,
          retryable: result.retryableRowIds.length,
        });
        if (result.rowCount === 0) continue;
        retryableViewportRowIds = result.retryableRowIds;

        const remaining = Object.fromEntries(
          Object.entries(result.tokensByRowId).filter(([rowId]) => !deliveredRowIds.has(rowId)),
        );
        enqueueChunk({
          ...result,
          tokensByRowId: remaining,
          rowCount: Object.keys(remaining).length,
        });
      }
    })();

    return () => {
      traceDiffHighlight("viewport-abort", { generation, reset });
      abortController.abort();
    };
  }, [collapsedFileIds, enabled, files, resetKey, rows, scheme, viewport, viewportScope]);

  const acknowledgeTokenPatch = useCallback((payload: Readonly<Record<string, unknown>>) => {
    const pending = pendingPatchesRef.current;
    const head = pending[0];
    traceDiffHighlight("patch-ack", {
      reset: diffHighlightTraceId(payload.resetKey),
      chunk: typeof payload.chunkIndex === "number" ? payload.chunkIndex : -1,
      matches:
        !!head && payload.resetKey === head.resetKey && payload.chunkIndex === head.chunkIndex,
      pending: pending.length,
    });
    if (!head || payload.resetKey !== head.resetKey || payload.chunkIndex !== head.chunkIndex)
      return;
    pending.shift();
    setTokensPatchJson(pending[0]?.json ?? createEmptyTokenPatch(head.resetKey));
  }, []);

  const rejectTokenPatch = useCallback(
    (payload: Readonly<Record<string, unknown>>) => {
      const head = pendingPatchesRef.current[0];
      traceDiffHighlight("patch-rejected", {
        reset: diffHighlightTraceId(payload.resetKey),
        chunk: typeof payload.chunkIndex === "number" ? payload.chunkIndex : -1,
        matches:
          !!head && payload.resetKey === head.resetKey && payload.chunkIndex === head.chunkIndex,
      });
      if (!head || payload.resetKey !== head.resetKey || payload.chunkIndex !== head.chunkIndex)
        return;
      for (const rowId of head.rowIds) highlightedRowIdsRef.current.delete(rowId);
      // Retry these rows only on a later viewport request, not in a failure loop.
      acknowledgeTokenPatch(payload);
    },
    [acknowledgeTokenPatch],
  );

  return {
    rejectTokenPatch,
    acknowledgeTokenPatch,
    tokensPatchJson,
    updateVisibleRange: scheduler.update,
  };
}
