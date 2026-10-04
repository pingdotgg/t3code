// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";

const present = vi.fn((..._args: ReadonlyArray<unknown>) => true);

vi.mock("./browserSurfaceStore", () => ({
  acquireBrowserSurface: () => ({ present, release: vi.fn() }),
}));

const resizeCallbacks = new Map<Element, () => void>();

class TestResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(element: Element) {
    resizeCallbacks.set(element, this.callback);
  }
  disconnect() {
    resizeCallbacks.clear();
  }
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  present.mockClear();
  resizeCallbacks.clear();
  vi.unstubAllGlobals();
});

function placeSlotAt(x: number) {
  const slot = host.querySelector("[data-browser-surface-slot]")!;
  slot.getBoundingClientRect = () => new DOMRect(x, 40, 240, 160);
}

describe("BrowserSurfaceSlot", () => {
  it("follows a marked container that moves the slot without resizing it", async () => {
    await act(async () =>
      root.render(
        <div data-browser-surface-container="true">
          <BrowserSurfaceSlot tabId="tab" visible />
        </div>,
      ),
    );
    const container = host.querySelector("[data-browser-surface-container]")!;

    placeSlotAt(12);
    resizeCallbacks.get(container)?.();

    expect(present).toHaveBeenLastCalledWith(
      { x: 12, y: 40, width: 240, height: 160 },
      true,
      0,
      30,
    );
  });
});
