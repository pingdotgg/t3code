import { useEffect, useMemo, useState } from "react";

import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import { computeVisibleNativeReviewWordDiffRanges } from "./nativeReviewWordDiffs";

interface NativeReviewCommentWordDiffPatch {
  readonly resetKey: string;
  readonly wordDiffRangesByRowId: Awaited<
    ReturnType<typeof computeVisibleNativeReviewWordDiffRanges>
  >["rangesByRowId"];
}

// Line numbers stay out of the key: they change the rows JSON without changing
// syntax tokens, and a reset would clear tokens native never gets resent.
function buildCommentRowsResetKey(rows: ReadonlyArray<NativeReviewDiffRow>): string {
  let hash = 5381;
  for (const row of rows) {
    const text = `${row.id}\n${row.content ?? ""}\n`;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 33) ^ text.charCodeAt(index);
    }
  }
  return `${rows.length}:${(hash >>> 0).toString(36)}`;
}

/** Word highlights for a comment card's rows, delivered as a patch like the review sheet. */
export function useNativeReviewCommentWordDiffs(input: {
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly enabled: boolean;
}) {
  const { enabled, rows } = input;
  const tokensResetKey = useMemo(() => buildCommentRowsResetKey(rows), [rows]);
  const [patch, setPatch] = useState<NativeReviewCommentWordDiffPatch>(() => ({
    resetKey: tokensResetKey,
    wordDiffRangesByRowId: {},
  }));
  const wordDiffRangesPatchJson = useMemo(() => JSON.stringify(patch), [patch]);

  useEffect(() => {
    if (!enabled || rows.length === 0) return;
    const abortController = new AbortController();
    void computeVisibleNativeReviewWordDiffRanges({
      rows,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      signal: abortController.signal,
    })
      .then((result) => {
        if (abortController.signal.aborted || result.pairCount === 0) return;
        setPatch({ resetKey: tokensResetKey, wordDiffRangesByRowId: result.rangesByRowId });
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted && typeof __DEV__ !== "undefined" && __DEV__) {
          console.log("[review-comment] word diff failed", { error, resetKey: tokensResetKey });
        }
      });
    return () => abortController.abort();
  }, [enabled, rows, tokensResetKey]);

  return { tokensResetKey, wordDiffRangesPatchJson };
}
