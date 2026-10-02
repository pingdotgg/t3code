import { afterEach, expect, it, vi } from "vite-plus/test";
import { observeTimelineColumn } from "./observeTimelineColumn";
import { resolveTimelineMinimapHitStripWidth } from "./MessagesTimeline.logic";

afterEach(() => vi.unstubAllGlobals());

it("disables the hit strip for detached rows and observes their mounted replacement", () => {
  const first = { isConnected: true, getBoundingClientRect: () => ({ width: 768 }) };
  const replacement = { isConnected: true, getBoundingClientRect: () => ({ width: 1400 }) };
  let current: typeof first | null = first;
  const viewport = {
    querySelector: () => current,
    getBoundingClientRect: () => ({ width: 1400 }),
  } as unknown as HTMLElement;
  let measure!: () => void;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  const cancelFrame = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  let initialMeasure!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    initialMeasure = callback;
    return 7;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const hitWidths: number[] = [];
  const cleanup = observeTimelineColumn(viewport, (width, contentWidth) => {
    hitWidths.push(resolveTimelineMinimapHitStripWidth(width, contentWidth));
  });
  initialMeasure(0);
  expect(hitWidths.at(-1)).toBe(40);
  expect(observe).toHaveBeenCalledWith(first);

  first.isConnected = false;
  measure();
  expect(hitWidths.at(-1)).toBe(0);
  expect(unobserve).toHaveBeenCalledWith(first);

  current = replacement;
  measure();
  expect(hitWidths.at(-1)).toBe(0);
  expect(observe).toHaveBeenCalledWith(replacement);

  current = null;
  measure();
  expect(hitWidths.at(-1)).toBe(0);
  expect(unobserve).toHaveBeenCalledWith(replacement);
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancelFrame).toHaveBeenCalledWith(7);
});
