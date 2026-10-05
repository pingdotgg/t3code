import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createReviewDiffHighlightScheduler } from "./reviewDiffHighlightScheduler";

describe("review diff highlighting while scrolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps requesting new rows during gradual scrolling through a large diff", () => {
    const request = vi.fn();
    const scheduler = createReviewDiffHighlightScheduler(request);
    for (let firstRowIndex = 1; firstRowIndex <= 1_674; firstRowIndex++) {
      scheduler.update({ firstRowIndex, lastRowIndex: firstRowIndex + 80 });
      vi.advanceTimersByTime(16);
    }
    expect(request.mock.calls.length).toBeGreaterThan(100);
    vi.advanceTimersByTime(150);
    expect(request).toHaveBeenLastCalledWith({ firstRowIndex: 1_674, lastRowIndex: 1_754 });
  });

  it("highlights the settled viewport even below the movement threshold", () => {
    const request = vi.fn();
    const scheduler = createReviewDiffHighlightScheduler(request);
    scheduler.update({ firstRowIndex: 2, lastRowIndex: 82 });
    vi.advanceTimersByTime(100);
    scheduler.update({ firstRowIndex: 3, lastRowIndex: 83 });
    vi.advanceTimersByTime(100);
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(request).toHaveBeenCalledExactlyOnceWith({ firstRowIndex: 3, lastRowIndex: 83 });
  });

  it("does not let repeated draw events starve the settled refresh", () => {
    const request = vi.fn();
    const scheduler = createReviewDiffHighlightScheduler(request);
    for (let i = 0; i < 10; i++) {
      scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
      vi.advanceTimersByTime(30);
    }
    expect(request).toHaveBeenCalledExactlyOnceWith({ firstRowIndex: 1, lastRowIndex: 81 });
  });

  it("requests large jumps and reverse scrolling immediately without stale timers", () => {
    const request = vi.fn();
    const scheduler = createReviewDiffHighlightScheduler(request);
    scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
    scheduler.update({ firstRowIndex: 1_000, lastRowIndex: 1_080 });
    scheduler.update({ firstRowIndex: 0, lastRowIndex: 80 });
    vi.runAllTimers();
    expect(request.mock.calls).toEqual([
      [{ firstRowIndex: 1_000, lastRowIndex: 1_080 }],
      [{ firstRowIndex: 0, lastRowIndex: 80 }],
    ]);
  });

  it("cancels pending work on disposal and resets the range for a new diff", () => {
    const request = vi.fn();
    const scheduler = createReviewDiffHighlightScheduler(request);
    scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
    scheduler.cancel();
    vi.runAllTimers();
    expect(request).not.toHaveBeenCalled();
    scheduler.update({ firstRowIndex: 1_000, lastRowIndex: 1_080 });
    request.mockClear();
    scheduler.update({ firstRowIndex: 1_001, lastRowIndex: 1_081 });
    scheduler.reset();
    vi.runAllTimers();
    expect(request).not.toHaveBeenCalled();
    scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(request).toHaveBeenCalledExactlyOnceWith({ firstRowIndex: 1, lastRowIndex: 81 });
  });
});
