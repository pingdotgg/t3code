import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

interface MeasuredElement {
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
}

class LayoutResizeObserver {
  static observers = new Set<LayoutResizeObserver>();
  readonly sizes = new Map<MeasuredElement, string>();

  constructor(readonly callback: () => void) {
    LayoutResizeObserver.observers.add(this);
  }

  observe(element: MeasuredElement) {
    this.sizes.set(element, this.size(element));
  }

  disconnect() {
    LayoutResizeObserver.observers.delete(this);
  }

  size(element: MeasuredElement) {
    const { width, height } = element.getBoundingClientRect();
    return `${width}:${height}`;
  }

  static deliverResizes() {
    for (const observer of this.observers) {
      let resized = false;
      for (const [element, previous] of observer.sizes) {
        const next = observer.size(element);
        if (next === previous) continue;
        observer.sizes.set(element, next);
        resized = true;
      }
      if (resized) observer.callback();
    }
  }
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("ResizeObserver", LayoutResizeObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  LayoutResizeObserver.observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BrowserSurfaceSlot", () => {
  it("follows an opening panel when the full-width slot moves without resizing", async () => {
    const tabId = "reopened-browser";
    let panelWidth = 0;
    const panel = {
      getBoundingClientRect: () => ({
        x: 1_280 - panelWidth,
        y: 0,
        width: panelWidth,
        height: 800,
      }),
    };
    const slot = {
      closest: () => panel,
      getBoundingClientRect: () => ({ x: 1_280 - panelWidth, y: 92, width: 539, height: 708 }),
    };

    await act(() => {
      renderer = create(<BrowserSurfaceSlot tabId={tabId} visible />, {
        createNodeMock: () => slot,
      });
    });
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]?.rect?.x).toBe(1_280);

    for (const width of [180, 360, 540]) {
      await act(() => {
        panelWidth = width;
        LayoutResizeObserver.deliverResizes();
      });
      expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
        visible: true,
        rect: { x: 1_280 - width, y: 92, width: 539, height: 708 },
      });
    }

    await act(() => renderer?.unmount());
    renderer = undefined;
    panelWidth = 0;
    LayoutResizeObserver.deliverResizes();
    expect(useBrowserSurfaceStore.getState().byTabId[tabId]).toMatchObject({
      visible: false,
      rect: { x: 740, y: 92, width: 539, height: 708 },
    });
    expect(LayoutResizeObserver.observers.size).toBe(0);
  });
});
