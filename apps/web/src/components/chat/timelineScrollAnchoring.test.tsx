import { MessageId, RunId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  observeTimelineRun,
  getAnchoredTurnMetrics,
  pinTimelineToEnd,
  scheduleTimelineEndPin,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("targets the real row end instead of any temporary reserved tail", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });
});

describe("observeTimelineRun", () => {
  const existing = {
    threadKey: "environment:thread",
    hydrated: true,
    runId: RunId.make("existing-run"),
    queued: false,
    messageId: MessageId.make("existing-message"),
  };
  const next = {
    ...existing,
    runId: RunId.make("new-run"),
    messageId: MessageId.make("new-message"),
  };

  it("does not mistake delayed hydration for a newly started turn", () => {
    const loading = { ...existing, hydrated: false, runId: null, messageId: null };
    const opened = observeTimelineRun(null, loading);
    const stillLoading = observeTimelineRun(opened.observation, loading);
    const hydrated = observeTimelineRun(stillLoading.observation, existing);
    expect(hydrated.anchorMessageId).toBeNull();
    expect(observeTimelineRun(hydrated.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("keeps the end position while a stale cached run is replaced during synchronization", () => {
    const cached = observeTimelineRun(null, { ...existing, hydrated: false });
    const synchronizing = observeTimelineRun(cached.observation, { ...next, hydrated: false });
    expect(synchronizing.anchorMessageId).toBeNull();
    const live = observeTimelineRun(synchronizing.observation, next);
    expect(live.anchorMessageId).toBeNull();
    expect(
      observeTimelineRun(live.observation, {
        ...next,
        runId: RunId.make("later-run"),
        messageId: MessageId.make("later-message"),
      }).anchorMessageId,
    ).toBe("later-message");
  });

  it("waits for a new run's user message and frames it only once", () => {
    const opened = observeTimelineRun(null, existing);
    const waiting = observeTimelineRun(opened.observation, { ...next, messageId: null });
    expect(waiting.anchorMessageId).toBeNull();
    const ready = observeTimelineRun(waiting.observation, next);
    expect(ready.anchorMessageId).toBe(next.messageId);
    expect(observeTimelineRun(ready.observation, next).anchorMessageId).toBeNull();
  });

  it("does not reset the baseline during a temporary loss of projection data", () => {
    const opened = observeTimelineRun(null, existing);
    const reconnecting = observeTimelineRun(opened.observation, {
      ...existing,
      hydrated: false,
      runId: null,
    });
    expect(observeTimelineRun(reconnecting.observation, existing).anchorMessageId).toBeNull();
  });

  it("waits for a queued run to start before framing it", () => {
    const opened = observeTimelineRun(null, { ...existing, queued: true });
    expect(opened.anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBe(
      existing.messageId,
    );
  });
});

describe("pinTimelineToEnd", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Runs queued animation frames one at a time; `heights[n]` is the content height on frame n.
  function setup(heights: readonly number[]) {
    const queue = new Map<number, () => void>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      queue.set(nextHandle, callback);
      return nextHandle++;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => queue.delete(handle));
    const listeners = new Map<string, (event: { target: unknown }) => void>();
    const element = {
      clientHeight: 700,
      scrollHeight: heights[0] ?? 700,
      scrollTop: 0,
      addEventListener: (type: string, listener: (event: { target: unknown }) => void) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    const scrollToEnd = vi.fn((options: { animated: boolean }) => {
      if (!options.animated) element.scrollTop = element.scrollHeight - element.clientHeight;
    });
    const list = { getScrollableNode: () => element as unknown as HTMLElement, scrollToEnd };
    let frameNumber = 0;
    const runFrame = () => {
      const [handle, callback] = [...queue.entries()][0] ?? [];
      if (handle === undefined || !callback) return false;
      queue.delete(handle);
      frameNumber += 1;
      element.scrollHeight = heights[Math.min(frameNumber, heights.length - 1)] ?? 700;
      callback();
      return true;
    };
    const runAllFrames = () => {
      let frames = 0;
      while (runFrame()) frames += 1;
      return frames;
    };
    return { element, listeners, list, scrollToEnd, runAllFrames, runFrame, queue };
  }

  it("keeps scrolling to the end while rows measure taller, then stops once the layout is quiet", () => {
    // The first scroll lands against 1,200px; the content ends at 5,000px.
    const { element, list, scrollToEnd, runAllFrames, queue } = setup([
      1200, 1200, 3000, 4200, 5000, 5000,
    ]);
    pinTimelineToEnd(list, () => true);

    runAllFrames();

    expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
    expect(scrollToEnd).toHaveBeenCalledTimes(4);
    expect(queue.size).toBe(0);
  });

  it("does nothing once the view is already at the end and the layout stays quiet", () => {
    const { element, list, scrollToEnd, runAllFrames } = setup([1200]);
    element.scrollTop = 500;
    pinTimelineToEnd(list, () => true);

    runAllFrames();

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("stops when the user scrolls", () => {
    const { element, list, listeners, scrollToEnd, runFrame, runAllFrames } = setup([
      1200, 3000, 5000,
    ]);
    pinTimelineToEnd(list, () => true);
    runFrame();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    listeners.get("wheel")?.({ target: element });

    expect(runAllFrames()).toBe(0);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("keeps following row growth after a click inside a message", () => {
    const { element, list, listeners, runFrame, runAllFrames } = setup([1200, 1200, 5000]);
    pinTimelineToEnd(list, () => true);
    runFrame();

    listeners.get("pointerdown")?.({ target: {} });
    element.scrollHeight = 5000;
    runAllFrames();

    expect(element.scrollHeight).toBe(5000);
    expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("stops correcting row growth when the user grabs the scrollbar", () => {
    const { element, list, listeners, runFrame, runAllFrames, scrollToEnd } = setup([
      1200, 1200, 5000,
    ]);
    pinTimelineToEnd(list, () => true);
    runFrame();

    listeners.get("pointerdown")?.({ target: element });

    expect(runAllFrames()).toBe(0);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("stops when the thread stops following the end", () => {
    const { list, scrollToEnd, runFrame, runAllFrames } = setup([1200, 3000, 5000]);
    let following = true;
    pinTimelineToEnd(list, () => following);
    runFrame();
    following = false;

    runAllFrames();

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2, 3])(
    "keeps an explicit smooth jump in control after %i growth-check frames",
    (framesBeforeJump) => {
      const { element, list, scrollToEnd, runFrame, runAllFrames, listeners } = setup([5000]);
      const cancelRef: { current: (() => void) | null } = { current: null };
      scheduleTimelineEndPin(list, () => true, cancelRef);
      for (let frame = 0; frame < framesBeforeJump; frame += 1) runFrame();
      // The explicit jump cancels corrections before scheduling its animated scroll.
      cancelRef.current?.();
      cancelRef.current = null;
      const offset = element.scrollTop;
      scrollToEnd.mockClear();
      requestAnimationFrame(() => void list.scrollToEnd({ animated: true }));
      runAllFrames();

      expect.soft(scrollToEnd.mock.calls.map(([options]) => options.animated)).toEqual([true]);
      expect.soft(element.scrollTop).toBe(offset);
      expect(listeners.size).toBe(0);
    },
  );

  it("corrects followed growth after layout and keeps the started pin cancellable after effect cleanup", () => {
    const { element, list, runFrame, runAllFrames, listeners, queue } = setup([5000]);
    const cancelRef: { current: (() => void) | null } = { current: null };
    const cleanup = scheduleTimelineEndPin(list, () => true, cancelRef);
    runFrame();
    runFrame();
    cleanup();
    runFrame();
    expect(element.scrollTop).toBe(4300);
    expect(listeners.size).toBeGreaterThan(0);

    cancelRef.current?.();
    runAllFrames();
    expect(listeners.size).toBe(0);
    expect(queue.size).toBe(0);
  });

  it.each([0, 1])("effect cleanup cancels a growth check after %i frames", (frames) => {
    const { list, scrollToEnd, runFrame, runAllFrames, queue } = setup([5000]);
    const cancelRef: { current: (() => void) | null } = { current: null };
    const cleanup = scheduleTimelineEndPin(list, () => true, cancelRef);
    for (let frame = 0; frame < frames; frame += 1) runFrame();
    cleanup();
    runAllFrames();
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });
});
