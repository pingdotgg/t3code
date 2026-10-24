import type { RefObject } from "react";

import {
  isNativeReviewDiffDrawEvent,
  type NativeReviewDiffViewHandle,
  type NativeReviewDiffViewProps,
} from "../diffs/nativeReviewDiffSurface";

export function pullRequestDiffInitialPosition(
  targetFileId: string | undefined,
  focusIndex: number,
): Pick<NativeReviewDiffViewProps, "initialRowIndex" | "initialFileId"> {
  // Explicit empty values also clear a previous destination on a reused native view.
  return {
    initialRowIndex: focusIndex >= 0 ? Math.max(0, focusIndex - 3) : -1,
    initialFileId: focusIndex >= 0 ? "" : (targetFileId ?? ""),
  };
}

export function handlePullRequestDiffDebugEvent(
  event: Parameters<NonNullable<NativeReviewDiffViewProps["onDebug"]>>[0],
  input: {
    readonly rowCount: number;
    readonly targetFileId: string | undefined;
    readonly focusIndex: number;
    readonly isIos: boolean;
    readonly nativeView: RefObject<NativeReviewDiffViewHandle | null>;
    readonly jumpStarted: RefObject<boolean>;
    readonly onDebug: NonNullable<NativeReviewDiffViewProps["onDebug"]>;
    readonly loadMore: () => void;
  },
) {
  const drawn = isNativeReviewDiffDrawEvent(event.nativeEvent);
  // Delivery outcomes and content mounts must reach the bridge even before rows decode.
  if (!drawn) input.onDebug(event);
  const decoded =
    event.nativeEvent.message === "rows-decoded" && event.nativeEvent.rows === input.rowCount;
  if (!drawn && !decoded) return;
  // Filtering replaces the native row payload asynchronously. Old draw events
  // must not consume the file jump or highlight the new payload's row indices.
  if (
    typeof event.nativeEvent.totalRows === "number" &&
    event.nativeEvent.totalRows !== input.rowCount
  )
    return;
  if (drawn) input.onDebug(event);
  if (
    input.targetFileId &&
    !input.jumpStarted.current &&
    input.nativeView.current &&
    (!input.isIos || decoded)
  ) {
    input.jumpStarted.current = true;
    if (input.focusIndex >= 0) return;
    void input.nativeView.current.scrollToFile(input.targetFileId, false).catch(() => {
      input.jumpStarted.current = false;
    });
    return;
  }
  if (!drawn) return;
  const lastRow = event.nativeEvent.lastRowIndex;
  if (typeof lastRow === "number" && lastRow >= input.rowCount - 40) input.loadMore();
}
