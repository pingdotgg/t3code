import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ View: () => null }));
vi.mock("expo", () => ({ requireNativeView: vi.fn() }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));

import {
  handlePullRequestDiffDebugEvent,
  pullRequestDiffInitialPosition,
} from "./pullRequestDiffDebug";
import { createReviewDiffHighlightScheduler } from "../review/reviewDiffHighlightScheduler";
import type { NativeReviewDiffViewProps } from "../diffs/nativeReviewDiffSurface";

it("enters at a file header without changing guide focus positioning", () => {
  expect(pullRequestDiffInitialPosition("last-file", -1)).toEqual({
    initialFileId: "last-file",
    initialRowIndex: -1,
  });
  expect(pullRequestDiffInitialPosition("last-file", 904)).toEqual({
    initialFileId: "",
    initialRowIndex: 901,
  });
  expect(pullRequestDiffInitialPosition(undefined, -1)).toEqual({
    initialFileId: "",
    initialRowIndex: -1,
  });
});

it.each([true, false])(
  "starts warm highlighting at the declared file without a JS jump (iOS: %s)",
  async (isIos) => {
    vi.useFakeTimers();
    // A warm engine can issue its source RPC immediately when the scheduler flushes.
    const sourceRequest = vi.fn();
    const scheduler = createReviewDiffHighlightScheduler(sourceRequest);
    const scrollToFile = vi.fn(async () => {});
    const loadMore = vi.fn();
    const jumpStarted = { current: true };
    const onDebug: NonNullable<NativeReviewDiffViewProps["onDebug"]> = ({ nativeEvent }) => {
      if (nativeEvent.message === "visible-range")
        scheduler.update({
          firstRowIndex: nativeEvent.firstRowIndex as number,
          lastRowIndex: nativeEvent.lastRowIndex as number,
        });
    };
    const emit = (nativeEvent: Record<string, unknown>) =>
      handlePullRequestDiffDebugEvent({ nativeEvent } as Parameters<typeof onDebug>[0], {
        rowCount: 1000,
        targetFileId: "last-file",
        focusIndex: -1,
        isIos,
        nativeView: { current: { scrollToFile, scrollToTop: vi.fn(async () => {}) } },
        jumpStarted,
        onDebug,
        loadMore,
      });
    try {
      const position = pullRequestDiffInitialPosition("last-file", -1);
      emit({ message: "rows-decoded", rows: 1000 });
      // Native applies the declared file before publishing its viewport. A later
      // imperative bridge command cannot retract an RPC started from a top range.
      const first = position.initialFileId === "last-file" ? 900 : 0;
      emit({
        message: "visible-range",
        firstRowIndex: first,
        lastRowIndex: first + 40,
        totalRows: 1000,
      });
      await vi.runOnlyPendingTimersAsync();
      expect(sourceRequest.mock.calls).toEqual([[{ firstRowIndex: 900, lastRowIndex: 940 }]]);
      expect(scrollToFile).not.toHaveBeenCalled();
      // Near-end pagination and stale-payload filtering still use native ranges.
      emit({ message: "visible-range", firstRowIndex: 950, lastRowIndex: 990, totalRows: 999 });
      expect(loadMore).not.toHaveBeenCalled();
      emit({ message: "visible-range", firstRowIndex: 950, lastRowIndex: 990, totalRows: 1000 });
      expect(loadMore).toHaveBeenCalledOnce();
    } finally {
      scheduler.cancel();
      vi.useRealTimers();
    }
  },
);
