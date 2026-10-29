import { useRef, useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useSidebarSwipe } from "./sidebarSwipe";
import { Sheet, SheetPopup, SheetTitle } from "./sheet";

function Harness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const sheetRef = useRef<HTMLDivElement>(null);
  useSidebarSwipe({ enabled: true, open, setOpen, sheetRef });
  return <div ref={sheetRef} data-open={open} onTouchMove={(event) => event.stopPropagation()} />;
}

function touch(target: HTMLElement, type: string, x: number, y: number, ended = false) {
  const point = new Touch({ identifier: 0, target, clientX: x, clientY: y });
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: ended ? [] : [point],
    changedTouches: [point],
  });
  target.dispatchEvent(event);
  return event;
}

function pointer(target: HTMLElement, type: string, x: number, pointerType = "touch") {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 7,
      pointerType,
      isPrimary: true,
      clientX: x,
      clientY: 200,
    }),
  );
}

describe("sidebar touch events", () => {
  it("opens when touch and pointer IDs differ, even after pointer cancellation", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 8);
      touch(target, "touchstart", 8, 200);
      pointer(target, "pointermove", 28);
      expect(touch(target, "touchmove", 28, 201).defaultPrevented).toBe(true);
      pointer(target, "pointercancel", 28);
      touch(target, "touchmove", 90, 201);
      touch(target, "touchend", 90, 201, true);
    });
    expect(target.dataset.open).toBe("true");
  });

  it("opens from the middle of the page", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      touch(target, "touchstart", 200, 200);
      expect(touch(target, "touchmove", 280, 201).defaultPrevented).toBe(true);
      touch(target, "touchend", 280, 201, true);
    });
    expect(target.dataset.open).toBe("true");
  });

  it("preserves horizontal scrolling inside code blocks", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    const code = document.createElement("pre");
    code.style.cssText = "width: 100px; overflow-x: auto";
    const content = document.createElement("code");
    content.style.cssText = "display: block; width: 500px";
    content.textContent = "A wide code block";
    code.append(content);
    target.append(code);
    expect(getComputedStyle(code).overflowX).toBe("auto");
    expect(code.scrollWidth).toBeGreaterThan(code.clientWidth + 1);
    await act(() => {
      touch(content, "touchstart", 200, 200);
      expect(touch(content, "touchmove", 280, 201).defaultPrevented).toBe(false);
      touch(content, "touchend", 280, 201, true);
    });
    expect(target.dataset.open).toBe("false");
  });

  it("closes when the sheet stops touch events from bubbling", async () => {
    await using screen = await render(<Harness initiallyOpen />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 250);
      touch(target, "touchstart", 250, 200);
      expect(touch(target, "touchmove", 170, 201).defaultPrevented).toBe(true);
      touch(target, "touchend", 170, 201, true);
    });
    expect(target.dataset.open).toBe("false");
  });

  it("leaves vertical scrolling alone", async () => {
    await using screen = await render(<Harness initiallyOpen />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      touch(target, "touchstart", 250, 200);
      expect(touch(target, "touchmove", 248, 270).defaultPrevented).toBe(false);
      touch(target, "touchend", 170, 280, true);
    });
    expect(target.dataset.open).toBe("true");
  });

  it("keeps mouse drags inert and supports pen drags", async () => {
    await using screen = await render(<Harness />, { router: false });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 8, "mouse");
      pointer(target, "pointerup", 90, "mouse");
    });
    expect(target.dataset.open).toBe("false");
    await act(() => {
      pointer(target, "pointerdown", 8, "pen");
      pointer(target, "pointermove", 90, "pen");
      pointer(target, "pointerup", 90, "pen");
    });
    expect(target.dataset.open).toBe("true");
  });
});

function PairedHarness({
  leftInitiallyOpen = false,
  rightInitiallyOpen = false,
}: {
  leftInitiallyOpen?: boolean;
  rightInitiallyOpen?: boolean;
}) {
  const [leftOpen, setLeftOpen] = useState(leftInitiallyOpen);
  const [rightOpen, setRightOpen] = useState(rightInitiallyOpen);
  const [chat, setChat] = useState<HTMLDivElement | null>(null);
  const leftSheet = useRef<HTMLDivElement>(null);
  const rightSheet = useRef<HTMLDivElement>(null);
  useSidebarSwipe({ enabled: true, open: leftOpen, setOpen: setLeftOpen, sheetRef: leftSheet });
  useSidebarSwipe({
    enabled: true,
    side: "right",
    open: rightOpen,
    setOpen: setRightOpen,
    sheetRef: rightSheet,
    openFrom: chat,
  });
  return (
    <section data-left-open={leftOpen} data-right-open={rightOpen}>
      <div ref={setChat} data-chat="" />
      <div data-outside="" />
      <div data-slot="sheet-viewport">
        <div ref={leftSheet} data-left="" />
      </div>
      <div data-slot="sheet-viewport">
        <div ref={rightSheet} data-right="" />
      </div>
    </section>
  );
}

function swipe(target: HTMLElement, startX: number, endX: number) {
  touch(target, "touchstart", startX, 200);
  touch(target, "touchmove", endX, 201);
  touch(target, "touchend", endX, 201, true);
}

describe("paired mobile drawers", () => {
  it("opens the right tray with a leftward swipe across chat", async () => {
    await using screen = await render(<PairedHarness />, { router: false });
    const state = screen.container.firstElementChild as HTMLElement;
    await act(() => swipe(state.querySelector("[data-chat]")!, 250, 150));
    expect(state.dataset.rightOpen).toBe("true");
    expect(state.dataset.leftOpen).toBe("false");
  });

  it("closes the right tray without opening the left sidebar", async () => {
    await using screen = await render(<PairedHarness rightInitiallyOpen />, { router: false });
    const state = screen.container.firstElementChild as HTMLElement;
    await act(() => swipe(state.querySelector("[data-right]")!, 150, 250));
    expect(state.dataset.rightOpen).toBe("false");
    expect(state.dataset.leftOpen).toBe("false");
  });

  it("closes the left sidebar without opening the right tray", async () => {
    await using screen = await render(<PairedHarness leftInitiallyOpen />, { router: false });
    const state = screen.container.firstElementChild as HTMLElement;
    await act(() => swipe(state.querySelector("[data-left]")!, 250, 150));
    expect(state.dataset.leftOpen).toBe("false");
    expect(state.dataset.rightOpen).toBe("false");
  });

  it("does not open the right tray from outside chat", async () => {
    await using screen = await render(<PairedHarness />, { router: false });
    const state = screen.container.firstElementChild as HTMLElement;
    await act(() => swipe(state.querySelector("[data-outside]")!, 250, 150));
    expect(state.dataset.rightOpen).toBe("false");
  });
});

function SheetHarness() {
  const [open, setOpen] = useState(true);
  const [clicks, setClicks] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  useSidebarSwipe({ enabled: true, side: "right", open, setOpen, sheetRef });
  return (
    <section data-open={open} data-clicks={clicks}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup ref={sheetRef} side="right" transitionDurationMs={0} showCloseButton={false}>
          <SheetTitle>Right tray</SheetTitle>
          <button onClick={() => setClicks((count) => count + 1)}>Tray action</button>
          <a
            href="#tray-link"
            onClick={(event) => {
              event.preventDefault();
              setClicks((count) => count + 1);
            }}
          >
            Tray link
          </a>
          <pre style={{ width: 100, overflowX: "auto" }}>
            <code style={{ display: "block", width: 500 }}>Wide tray code</code>
          </pre>
        </SheetPopup>
      </Sheet>
    </section>
  );
}

describe("actual right sheet gestures", () => {
  it.each(["button", "a"])(
    "delivers a %s click after tiny horizontal tap drift",
    async (selector) => {
      await using screen = await render(<SheetHarness />, { router: false });
      const state = screen.container.firstElementChild as HTMLElement;
      const target = document.querySelector(`[data-slot='sheet-popup'] ${selector}`) as HTMLElement;
      await act(() => {
        pointer(target, "pointerdown", 150);
        touch(target, "touchstart", 150, 200);
        expect(touch(target, "touchmove", 152, 200).defaultPrevented).toBe(false);
        touch(target, "touchend", 152, 200, true);
        target.click();
      });
      expect(state.dataset.clicks).toBe("1");
      expect(state.dataset.open).toBe("true");
    },
  );

  it("leaves code scrolling to the open tray and still closes from ordinary content", async () => {
    await using screen = await render(<SheetHarness />, { router: false });
    const state = screen.container.firstElementChild as HTMLElement;
    const code = document.querySelector("[data-slot='sheet-popup'] code") as HTMLElement;
    expect(code.parentElement!.scrollWidth).toBeGreaterThan(code.parentElement!.clientWidth + 1);
    await act(() => {
      pointer(code, "pointerdown", 150);
      touch(code, "touchstart", 150, 200);
      expect(touch(code, "touchmove", 250, 201).defaultPrevented).toBe(false);
      touch(code, "touchend", 250, 201, true);
    });
    expect(state.dataset.open).toBe("true");
    const button = document.querySelector("[data-slot='sheet-popup'] button") as HTMLElement;
    await act(() => {
      pointer(button, "pointerdown", 150);
      swipe(button, 150, 250);
      button.click();
    });
    expect(state.dataset.open).toBe("false");
    expect(state.dataset.clicks).toBe("0");
  });

  it("does not claim a tiny horizontal drift followed by vertical scrolling", async () => {
    await using screen = await render(<SheetHarness />, { router: false });
    const state = screen.container.firstElementChild as HTMLElement;
    const target = document.querySelector("[data-slot='sheet-popup'] button") as HTMLElement;
    await act(() => {
      pointer(target, "pointerdown", 150);
      touch(target, "touchstart", 150, 200);
      expect(touch(target, "touchmove", 152, 200).defaultPrevented).toBe(false);
      expect(touch(target, "touchmove", 153, 240).defaultPrevented).toBe(false);
      touch(target, "touchend", 153, 240, true);
    });
    expect(state.dataset.open).toBe("true");
  });
});
