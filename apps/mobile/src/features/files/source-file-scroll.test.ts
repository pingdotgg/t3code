import { expect, it, vi } from "vite-plus/test";

import { createSourceLineScroll } from "./source-file-scroll";

const ROW_HEIGHT = 24;

// Mirrors VirtualizedList.scrollToIndex without getItemLayout: indices past the highest
// measured cell fail, and unmeasured indices below it scroll to an averaged estimate.
function setup({
  lineCount = 1_203,
  measuredThrough = 79,
  rowHeight = (_index: number): number => ROW_HEIGHT,
} = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", (frame: ReturnType<typeof setTimeout>) =>
    clearTimeout(frame),
  );
  const measured = new Set<number>();
  const state = {
    lineCount,
    offset: 0,
    measure(from: number, to: number) {
      for (let index = from; index <= to; index += 1) measured.add(index);
    },
  };
  state.measure(0, measuredThrough);
  const offsetOf = (index: number) => {
    let offset = 0;
    for (let row = 0; row < index; row += 1) offset += rowHeight(row);
    return offset;
  };
  const averageItemLength = () => {
    let total = 0;
    for (const index of measured) total += rowHeight(index);
    return total / measured.size;
  };
  const scrollToIndex = vi.fn((params: { index: number }) => {
    if (params.index < 0 || params.index >= state.lineCount) {
      throw new Error(`scrollToIndex out of range: requested index ${params.index}`);
    }
    const highestMeasuredFrameIndex = Math.max(...measured);
    if (params.index > highestMeasuredFrameIndex) {
      scroll.onScrollToIndexFailed({
        index: params.index,
        averageItemLength: averageItemLength(),
        highestMeasuredFrameIndex,
      });
      return;
    }
    state.offset = measured.has(params.index)
      ? offsetOf(params.index)
      : averageItemLength() * params.index;
  });
  const scrollToOffset = vi.fn((params: { offset: number }) => {
    state.offset = params.offset;
  });
  const list = {
    get props() {
      return { data: { length: state.lineCount } };
    },
    scrollToIndex,
    scrollToOffset,
  };
  const scroll = createSourceLineScroll();
  return {
    scroll,
    list,
    state,
    offsetOf,
    scrollToIndex,
    scrollToOffset,
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

it("lands on an already measured line", () => {
  using t = setup();

  t.scroll.scrollToLine(t.list, 40);
  vi.runAllTimers();

  expect(t.state.offset).toBe(t.offsetOf(40));
  expect(t.scrollToOffset).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("jumps near an unmeasured wrapped line, then lands on it once rows measure", () => {
  using t = setup({ rowHeight: (index) => (index >= 80 ? ROW_HEIGHT * 3 : ROW_HEIGHT) });

  t.scroll.scrollToLine(t.list, 899);
  expect(() => vi.advanceTimersToNextTimer()).not.toThrow();
  expect(t.state.offset).toBeGreaterThan(0);

  // The render batch after the estimated jump measures rows past the target first, so
  // the next scrollToIndex is accepted against an averaged estimate.
  t.state.measure(900, 979);
  vi.advanceTimersToNextTimer();
  expect(t.state.offset).not.toBe(t.offsetOf(899));

  t.state.measure(820, 899);
  vi.runAllTimers();

  expect(t.state.offset).toBe(t.offsetOf(899));
  expect(vi.getTimerCount()).toBe(0);
});

it("stops retrying when the target never measures", () => {
  using t = setup({ rowHeight: (index) => (index === 899 ? ROW_HEIGHT * 400 : ROW_HEIGHT) });

  t.scroll.scrollToLine(t.list, 899);
  expect(() => vi.runAllTimers()).not.toThrow();

  expect(t.scrollToIndex.mock.calls.length).toBeLessThanOrEqual(10);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a line outside the document", () => {
  using t = setup({ lineCount: 12 });

  expect(() => t.scroll.scrollToLine(t.list, 899)).not.toThrow();
  vi.runAllTimers();
  expect(t.scrollToIndex).not.toHaveBeenCalled();
  expect(t.scrollToOffset).not.toHaveBeenCalled();
});

it("drops a pending jump when the document shrinks or the jump is cancelled", () => {
  using t = setup();

  t.scroll.scrollToLine(t.list, 899);
  vi.advanceTimersToNextTimer();
  t.state.lineCount = 12;
  expect(() => vi.runAllTimers()).not.toThrow();

  t.state.lineCount = 1_203;
  t.scroll.scrollToLine(t.list, 899);
  vi.advanceTimersToNextTimer();
  const calls = t.scrollToIndex.mock.calls.length;
  t.scroll.cancel();
  t.state.measure(80, 999);
  vi.runAllTimers();
  expect(t.scrollToIndex).toHaveBeenCalledTimes(calls);
});

it("a drag before the first frame cancels the jump", () => {
  using t = setup();

  t.scroll.scrollToLine(t.list, 40);
  t.scroll.cancel();
  vi.runAllTimers();

  expect(t.scrollToIndex).not.toHaveBeenCalled();
});
