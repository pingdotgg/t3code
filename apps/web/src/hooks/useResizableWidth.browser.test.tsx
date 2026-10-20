import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

function Panel({
  edge = "left",
  maxWidth = 800,
  storageKey = "test-panel-width",
}: {
  edge?: "left" | "right";
  maxWidth?: number;
  storageKey?: string;
}) {
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth: 400,
    minWidth: 200,
    maxWidth,
    edge,
  });
  return (
    <aside data-testid="host">
      <output>{width}</output>
      <div data-testid="handle" {...handlers} />
    </aside>
  );
}

async function renderPanel() {
  await using stack = new AsyncDisposableStack();
  let captured = false;
  let frame: FrameRequestCallback | undefined;
  const cancelAnimationFrame = vi.fn();
  stack.use(
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 42;
    }),
  );
  stack.use(vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelAnimationFrame));
  const setItem = stack.use(vi.spyOn(Storage.prototype, "setItem"));
  localStorage.clear();
  stack.defer(() => localStorage.clear());
  let screen: Screen = stack.use(await render(<Panel />));
  const container = () => screen.container;
  const host = () => container().querySelector<HTMLElement>("[data-testid=host]")!;

  function handle() {
    const element = container().querySelector<HTMLElement>("[data-testid=handle]")!;
    // Synthetic pointers have no active pointer for the browser to capture.
    element.setPointerCapture = () => {
      captured = true;
    };
    element.hasPointerCapture = () => captured;
    element.releasePointerCapture = () => {
      captured = false;
    };
    return element;
  }

  const environment = stack.move();
  return {
    setItem,
    cancelAnimationFrame,
    get captured() {
      return captured;
    },
    frame: () => frame?.(0),
    host,
    shownWidth: () => Number(container().querySelector("output")!.textContent),
    liveWidth: () => host().style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY),
    pointer(
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture",
      clientX = 100,
    ) {
      handle().dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX,
        }),
      );
    },
    rerender: (element: ReactNode = <Panel />) => screen.rerender(element),
    unmount: () => screen.unmount(),
    async mountFresh(element: ReactNode = <Panel />) {
      screen = environment.use(await render(element));
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

const bodyStyle = () => document.body.style;

describe("panel resize cleanup", () => {
  it.each(["unmount", "lost capture", "blur", "cancel"])(
    "clears the cursor and pending resize after %s",
    async (reason) => {
      await using panel = await renderPanel();
      const { pointer, host, shownWidth, liveWidth, setItem, cancelAnimationFrame } = panel;
      await act(() => {
        pointer("pointerdown");
        pointer("pointermove", 50);
      });
      const resizedHost = host();
      await act(() => panel.frame());
      expect(liveWidth()).toBe("450px");
      expect(resizedHost.style.getPropertyValue("transition-property")).toBe("none");
      expect(shownWidth()).toBe(400);
      await act(() => pointer("pointermove", 25));
      expect(bodyStyle().cursor).toBe("col-resize");
      expect(bodyStyle().userSelect).toBe("none");
      if (reason === "unmount") await panel.unmount();
      await act(() => {
        if (reason === "lost capture") pointer("lostpointercapture");
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        if (reason === "cancel") pointer("pointercancel");
      });
      expect(bodyStyle().cursor).toBe("");
      expect(bodyStyle().userSelect).toBe("");
      expect(panel.captured).toBe(false);
      expect(resizedHost.style.getPropertyValue("transition-property")).toBe("");
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
      if (reason === "unmount") {
        expect(setItem).not.toHaveBeenCalled();
        await panel.mountFresh();
      } else {
        expect(shownWidth()).toBe(475);
        expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
      }
    },
  );

  it.each(["left", "right"] as const)(
    "uses the release position for a fast %s-edge drag",
    async (edge) => {
      await using panel = await renderPanel();
      const { pointer, shownWidth, setItem, cancelAnimationFrame } = panel;
      await panel.rerender(<Panel edge={edge} />);
      await act(() => {
        pointer("pointerdown");
        pointer("pointermove", edge === "left" ? 50 : 150);
        pointer("pointerup", edge === "left" ? 25 : 175);
      });
      expect(shownWidth()).toBe(475);
      expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
      expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    },
  );

  it.each([
    [800, 450],
    [450, 800],
  ])("uses updated bounds during a drag from max %s to %s", async (initialMax, nextMax) => {
    await using panel = await renderPanel();
    const { pointer, shownWidth, liveWidth, setItem } = panel;
    await panel.rerender(<Panel maxWidth={initialMax} />);
    await act(() => {
      pointer("pointerdown");
      pointer("pointermove", -200);
    });
    await act(() => panel.frame());
    expect(liveWidth()).toBe(`${Math.min(700, initialMax)}px`);
    await panel.rerender(<Panel maxWidth={nextMax} />);
    await act(() => pointer("pointermove", -250));
    await act(() => panel.frame());
    expect(liveWidth()).toBe(`${Math.min(750, nextMax)}px`);
    await act(() => pointer("pointerup", -300));
    expect(shownWidth()).toBe(nextMax);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", String(nextMax));
  });

  it("handles release before any move event", async () => {
    await using panel = await renderPanel();
    const { pointer, shownWidth, setItem } = panel;
    await act(() => {
      pointer("pointerdown");
      pointer("pointerup", 25);
    });
    expect(shownWidth()).toBe(475);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "475");
  });

  it("clamps the release position to the panel bounds", async () => {
    await using panel = await renderPanel();
    const { pointer, shownWidth, setItem } = panel;
    await act(() => {
      pointer("pointerdown");
      pointer("pointerup", -1000);
    });
    expect(shownWidth()).toBe(800);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "800");
  });

  it("saves the final width when release is followed by lost capture", async () => {
    await using panel = await renderPanel();
    const { pointer, shownWidth, setItem } = panel;
    await act(() => {
      pointer("pointerdown");
      pointer("pointermove", 50);
      pointer("pointerup", 50);
      pointer("lostpointercapture", 50);
    });
    expect(shownWidth()).toBe(450);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("test-panel-width", "450");
    expect(bodyStyle().cursor).toBe("");
    expect(panel.captured).toBe(false);
  });
});

describe("panel width storage changes", () => {
  it("restores separate thread widths without remounting and retains them after reload", async () => {
    await using panel = await renderPanel();
    const { pointer, shownWidth } = panel;
    await act(() => {
      pointer("pointerdown");
      pointer("pointermove", 50);
      pointer("pointerup", 50);
    });
    expect(shownWidth()).toBe(450);
    await panel.rerender(<Panel storageKey="thread-b" />);
    expect(shownWidth()).toBe(400);
    await act(() => {
      pointer("pointerdown");
      pointer("pointermove", -100);
      pointer("pointerup", -100);
    });
    expect(shownWidth()).toBe(600);
    await panel.rerender(<Panel />);
    expect(shownWidth()).toBe(450);
    await panel.unmount();
    await panel.mountFresh(<Panel storageKey="thread-b" />);
    expect(shownWidth()).toBe(600);
  });

  it("cancels an unfinished drag on a thread switch without saving it to either thread", async () => {
    await using panel = await renderPanel();
    const { pointer, shownWidth, liveWidth, setItem } = panel;
    localStorage.setItem("thread-b", "650");
    setItem.mockClear();
    await act(() => {
      pointer("pointerdown");
      pointer("pointermove", 50);
    });
    await act(() => panel.frame());
    expect(liveWidth()).toBe("450px");
    await act(() => pointer("pointermove", 25));
    await panel.rerender(<Panel storageKey="thread-b" />);
    expect(shownWidth()).toBe(650);
    expect(liveWidth()).toBe("650px");
    expect(panel.captured).toBe(false);
    expect(bodyStyle().cursor).toBe("");
    await act(() => {
      panel.frame();
      pointer("pointerup", 25);
    });
    expect(shownWidth()).toBe(650);
    expect(setItem).not.toHaveBeenCalled();
    await panel.rerender(<Panel />);
    expect(shownWidth()).toBe(400);
  });
});
