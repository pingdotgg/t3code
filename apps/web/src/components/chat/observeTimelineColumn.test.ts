import { afterEach, expect, it, vi } from "vite-plus/test";
import { observeTimelineColumn } from "./observeTimelineColumn";
import { resolveTimelineMinimapHitStripWidth } from "./MessagesTimeline.logic";

afterEach(() => vi.unstubAllGlobals());

it("disables the hit strip for detached rows and observes their mounted replacement", () => {
  class ElementStub {
    matches = () => true;
    querySelector = () => null;
    closest = () => null;
  }
  vi.stubGlobal("Element", ElementStub);
  const first = { isConnected: true, getBoundingClientRect: () => ({ width: 768 }) };
  const replacement = Object.assign(new ElementStub(), {
    isConnected: true,
    getBoundingClientRect: () => ({ width: 768 }),
  });
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
  let rowsChanged!: (records: MutationRecord[]) => void;
  const observeRows = vi.fn();
  const disconnectRows = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: (records: MutationRecord[]) => void) {
        rowsChanged = callback;
      }
      observe = observeRows;
      disconnect = disconnectRows;
    },
  );
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
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    initialMeasure = callback;
    return 7;
  });
  vi.stubGlobal("requestAnimationFrame", requestFrame);
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
  // Only insertion fires: the viewport and old row do not resize again.
  rowsChanged([{ target: viewport, addedNodes: [replacement] } as unknown as MutationRecord]);
  initialMeasure(0);
  expect(hitWidths.at(-1)).toBe(40);
  expect(observe).toHaveBeenCalledWith(replacement);
  expect(observeRows).toHaveBeenCalledWith(viewport, { childList: true, subtree: true });

  const streamedNode = new ElementStub();
  streamedNode.matches = () => false;
  const scheduledCount = requestFrame.mock.calls.length;
  rowsChanged([{ target: replacement, addedNodes: [streamedNode] } as unknown as MutationRecord]);
  expect(requestFrame.mock.calls.length).toBe(scheduledCount);

  replacement.getBoundingClientRect = () => ({ width: 1400 });
  measure();
  expect(hitWidths.at(-1)).toBe(0);

  current = null;
  measure();
  expect(hitWidths.at(-1)).toBe(0);
  expect(unobserve).toHaveBeenCalledWith(replacement);
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(disconnectRows).toHaveBeenCalledOnce();
  expect(cancelFrame).toHaveBeenCalledWith(7);
});
