// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { PreviewMiniPlayerShell } from "./PreviewMiniPlayerShell";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const source = browserMiniPlayerSource("tab");
const callbacks = new Set<() => void>();
let viewport: { width: number; height: number };
let root: Root;
let parentRenders: number;

function Preview() {
  const activeSource = usePreviewMiniPlayerStore(
    (state) => selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef)?.source,
  );
  parentRenders++;
  return activeSource ? (
    <PreviewMiniPlayerShell
      threadRef={threadRef}
      source={activeSource}
      sourceSize={{ width: 1600, height: 1000 }}
      label="Floating browser preview"
      onOpenInPanel={() => undefined}
    >
      {() => <BrowserSurfaceSlot tabId="tab" visible fitSourceContent />}
    </PreviewMiniPlayerShell>
  ) : null;
}

const player = () => document.querySelector<HTMLElement>("[data-preview-mini-player]")!;
const moveButton = () =>
  document.querySelector<HTMLElement>('[aria-label="Move floating preview"]')!;
const resizeHandle = () =>
  document.querySelector<HTMLElement>('[data-preview-mini-player-resize="northwest"]')!;
const floatingState = () =>
  selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, threadRef)!;
const frame = () => ({
  x: Number.parseFloat(player().style.left),
  y: Number.parseFloat(player().style.top),
  width: Number.parseFloat(player().style.width),
  height: Number.parseFloat(player().style.height),
});

async function pointer(target: HTMLElement, type: string, x: number, y: number, buttons = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons });
  Object.defineProperty(event, "pointerId", { value: 1 });
  await act(() => target.dispatchEvent(event));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = { width: 1400, height: 800 };
  parentRenders = 0;
  callbacks.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly callback: () => void) {
        callbacks.add(callback);
      }
      observe() {}
      disconnect() {
        callbacks.delete(this.callback);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => viewport.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewport.height);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, viewport.width, viewport.height),
  );
  let captured = false;
  vi.stubGlobal("PointerEvent", MouseEvent);
  HTMLElement.prototype.setPointerCapture = () => {
    captured = true;
  };
  HTMLElement.prototype.hasPointerCapture = () => captured;
  HTMLElement.prototype.releasePointerCapture = () => {
    captured = false;
  };
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useBrowserSurfaceStore.setState({ byTabId: {} });
  usePreviewMiniPlayerStore.getState().open(threadRef, source);
  usePreviewMiniPlayerStore.getState().resize(threadRef, "browser:tab", 480, { x: 800, y: 300 });
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(() => root.render(<Preview />));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("floating preview gestures", () => {
  it("moves freely over the app without changing size or rerendering its parent", async () => {
    const initialRenders = parentRenders;
    const handle = moveButton();
    await pointer(handle, "pointerdown", 1000, 350);
    await pointer(handle, "pointermove", 300, 130);
    await pointer(handle, "pointerup", 300, 130, 0);

    expect(frame()).toEqual({ x: 100, y: 80, width: 480, height: 300 });
    expect(floatingState().width).toBe(480);
    expect(parentRenders).toBe(initialRenders);
    expect(document.getElementById("root")!.contains(player())).toBe(false);
  });

  it("keeps an anchored resize unchanged when switching to a move", async () => {
    const edge = resizeHandle();
    await pointer(edge, "pointerdown", 800, 300);
    await pointer(edge, "pointermove", 640, 200);
    await pointer(edge, "pointerup", 640, 200, 0);
    expect(frame()).toEqual({ x: 640, y: 200, width: 640, height: 400 });

    const handle = moveButton();
    await pointer(handle, "pointerdown", 800, 240);
    await pointer(handle, "pointermove", 200, 80);
    await pointer(handle, "pointerup", 200, 80, 0);
    expect(frame()).toEqual({ x: 40, y: 40, width: 640, height: 400 });
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture", "blur", "missing-release"])(
    "stops resizing after %s so hovering cannot move or resize the preview",
    async (ending) => {
      const edge = resizeHandle();
      await pointer(edge, "pointerdown", 800, 300);
      await pointer(edge, "pointermove", 640, 200);
      const resized = frame();
      if (ending === "blur") await act(() => window.dispatchEvent(new Event("blur")));
      else if (ending === "missing-release") await pointer(edge, "pointermove", 400, 100, 0);
      else await pointer(edge, ending, 640, 200, 0);
      await pointer(edge, "pointermove", 100, 100, 0);
      expect(frame()).toEqual(resized);

      const handle = moveButton();
      await pointer(handle, "pointerdown", 800, 240);
      await pointer(handle, "pointermove", 200, 80);
      await pointer(handle, "pointerup", 200, 80, 0);
      expect(frame()).toEqual({ x: 40, y: 40, width: 640, height: 400 });
    },
  );

  it("ignores plain hover events on every resize edge", async () => {
    const initial = frame();
    for (const edge of document.querySelectorAll<HTMLElement>(
      "[data-preview-mini-player-resize]",
    )) {
      await pointer(edge, "pointermove", 100, 100, 0);
    }
    await pointer(moveButton(), "pointermove", 100, 100, 0);
    expect(frame()).toEqual(initial);
  });

  it("restores the chosen frame after a temporary window shrink", async () => {
    const initial = frame();
    viewport = { width: 400, height: 400 };
    await act(() => {
      for (const callback of callbacks) callback();
    });
    expect(frame().width).toBe(376);
    expect(floatingState()).toMatchObject({ width: 480, position: { x: 800, y: 300 } });
    viewport = { width: 1400, height: 800 };
    await act(() => {
      for (const callback of callbacks) callback();
    });
    expect(frame()).toEqual(initial);
  });
});

describe("browser panel handoff", () => {
  it("keeps the floating lease while an invisible panel remains mounted or mounts again", async () => {
    const fittedOwner = useBrowserSurfaceStore.getState().byTabId.tab!.owner;
    await act(() =>
      root.render(
        <>
          <Preview />
          <BrowserSurfaceSlot tabId="tab" visible={false} />
        </>,
      ),
    );
    await act(() => {
      for (const callback of callbacks) callback();
    });
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      owner: fittedOwner,
      fitSourceContent: true,
      visible: true,
    });

    await act(() => root.render(<BrowserSurfaceSlot tabId="tab" visible />));
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      fitSourceContent: false,
      visible: true,
    });

    await act(() =>
      root.render(
        <>
          <Preview />
          <BrowserSurfaceSlot tabId="tab" visible={false} />
        </>,
      ),
    );
    expect(useBrowserSurfaceStore.getState().byTabId.tab).toMatchObject({
      fitSourceContent: true,
      visible: true,
    });
  });
});
