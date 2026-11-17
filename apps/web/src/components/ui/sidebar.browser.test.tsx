import { useRef, useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { Sheet, SheetPopup, SheetTitle } from "./sheet";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./sidebar";
import { useSidebarSwipe } from "./sidebarSwipe";

function CollapseFromInside() {
  const { setOpen } = useSidebar();
  return (
    <button type="button" onClick={() => setOpen(false)}>
      Collapse
    </button>
  );
}

function Harness(props: { readonly onResize?: (width: number) => void }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        collapsible="offcanvas"
        resizable={{
          minWidth: 200,
          maxWidth: 600,
          ...(props.onResize ? { onResize: props.onResize } : {}),
        }}
      >
        <CollapseFromInside />
        <SidebarRail />
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

describe("Sidebar", () => {
  it("hands focus to the outside trigger when it collapses around the focused control", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<Harness />, { router: false /* no routes involved */ });

    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));

    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    await vi.waitFor(() => expect(sidebar.inert).toBe(true));
    const trigger = screen.container.querySelector('[data-slot="sidebar-trigger"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("abandons a rail drag when the sidebar collapses mid-drag", async () => {
    await page.viewport(1280, 800);
    const onResize = vi.fn();
    await using screen = await render(<Harness onResize={onResize} />, {
      router: false /* no routes involved */,
    });
    const rail = screen.container.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    const { left, top } = rail.getBoundingClientRect();
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: top + 10 };
    const dragTo = (clientX: number) => {
      rail.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: left }));
      rail.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX }));
    };
    // A completed drag commits, so the abandoned one below is a real drag too.
    dragTo(left + 40);
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 40 }));
    expect(onResize).toHaveBeenCalledTimes(1);

    dragTo(left + 80);
    await userEvent.click(
      screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
    );
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 80 }));

    expect(onResize).toHaveBeenCalledTimes(1);
  });
});

it("restores collapsed and expanded desktop state after remounting", async () => {
  await page.viewport(1280, 800);
  const storageKey = "sidebar_persistence_test";
  localStorage.removeItem(storageKey);
  const layout = () => (
    <SidebarProvider storageKey={storageKey}>
      <SidebarTrigger />
    </SidebarProvider>
  );
  {
    await using screen = await render(layout(), { router: false /* no routes involved */ });
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
  }
  {
    await using screen = await render(layout(), { router: false /* no routes involved */ });
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(trigger);
  }
  await using screen = await render(layout(), { router: false /* no routes involved */ });
  await expect
    .element(screen.getByRole("button", { name: "Toggle Sidebar" }))
    .toHaveAttribute("aria-pressed", "true");
  localStorage.removeItem(storageKey);
});

it("keeps the mobile sheet closed and leaves the saved desktop state alone", async () => {
  await page.viewport(390, 844);
  const storageKey = "sidebar_mobile_persistence_test";
  localStorage.setItem(storageKey, "false");
  {
    await using screen = await render(
      <SidebarProvider storageKey={storageKey}>
        <SidebarTrigger />
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(storageKey)).toBe("false");
  }
  await using screen = await render(
    <SidebarProvider storageKey={storageKey}>
      <SidebarTrigger />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  await expect
    .element(screen.getByRole("button", { name: "Toggle Sidebar" }))
    .toHaveAttribute("aria-pressed", "false");
  localStorage.removeItem(storageKey);
});

function MobileSheetMountedProbe() {
  const { mobileSheetMounted } = useSidebar();
  return <output aria-label="Sheet mounted">{String(mobileSheetMounted)}</output>;
}

it("keeps closed mobile sheet contents mounted and reports the sheet only while it shows", async () => {
  await page.viewport(390, 844);
  await using screen = await render(
    <SidebarProvider>
      <Sidebar>
        <span>Sheet contents</span>
      </Sidebar>
      <SidebarTrigger />
      <MobileSheetMountedProbe />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  const sheetMounted = screen.getByLabelText("Sheet mounted");
  // Window shortcuts registered by sidebar children only work while they stay mounted.
  expect(document.querySelector('[data-mobile="true"]')?.textContent).toContain("Sheet contents");
  await expect.element(sheetMounted).toHaveTextContent("false");

  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  await expect.element(sheetMounted).toHaveTextContent("true");

  await userEvent.keyboard("{Escape}");
  await expect.element(sheetMounted).toHaveTextContent("false");
  expect(document.querySelector('[data-mobile="true"]')?.textContent).toContain("Sheet contents");
});

it("opens the mobile sheet without a transition while panel animations are off", async () => {
  await page.viewport(390, 844);
  await using screen = await render(
    <div data-panel-animations="false">
      <SidebarProvider>
        <Sidebar>
          <span>Sheet contents</span>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>
    </div>,
    { router: false /* no routes involved */ },
  );
  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  const popup = document.querySelector<HTMLElement>('[data-mobile="true"][data-sidebar="sidebar"]');
  expect(popup).not.toBeNull();
  expect(getComputedStyle(popup!).transitionDuration).toBe("0s");
});

// Drawer swipes. Gesture bookkeeping is unit-tested in sidebarSwipe.logic.test.ts;
// these cover what needs a browser: capture listeners, real sheets, layout, focus and clicks.

function touch(target: Element, type: string, x: number, y: number, ended = false) {
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

function swipe(target: Element, startX: number, endX: number) {
  touch(target, "touchstart", startX, 200);
  touch(target, "touchmove", endX, 201);
  touch(target, "touchend", endX, 201, true);
}

function SwipeHarness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const sheetRef = useRef<HTMLDivElement>(null);
  useSidebarSwipe({ enabled: true, open, setOpen, sheetRef });
  return <div ref={sheetRef} data-open={open} onTouchMove={(event) => event.stopPropagation()} />;
}

function PairedHarness() {
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
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

function SheetHarness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [clicks, setClicks] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  useSidebarSwipe({ enabled: true, side: "right", open, setOpen, sheetRef });
  return (
    <section data-open={open} data-clicks={clicks}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup ref={sheetRef} side="right" transitionDurationMs={0} showCloseButton={false}>
          <SheetTitle>Right tray</SheetTitle>
          <button onClick={() => setClicks((count) => count + 1)}>Tray action</button>
          <pre style={{ width: 100, overflowX: "auto" }}>
            <code style={{ display: "block", width: 500 }}>Wide tray code</code>
          </pre>
        </SheetPopup>
      </Sheet>
    </section>
  );
}

describe("drawer swipes", () => {
  it("closes from capture listeners when the sheet stops touch events from bubbling", async () => {
    await using screen = await render(<SwipeHarness initiallyOpen />, {
      router: false /* isolated gesture harness */,
    });
    const target = screen.container.firstElementChild as HTMLElement;
    await act(() => {
      touch(target, "touchstart", 250, 200);
      expect(touch(target, "touchmove", 170, 201).defaultPrevented).toBe(true);
      touch(target, "touchend", 170, 201, true);
    });
    expect(target.dataset.open).toBe("false");
  });

  it("keeps the left sidebar and right tray to their own targets", async () => {
    await using screen = await render(<PairedHarness />, {
      router: false /* isolated gesture harness */,
    });
    const state = screen.container.firstElementChild as HTMLElement;
    const part = (name: string) => state.querySelector(`[data-${name}]`)!;

    await act(() => swipe(part("outside"), 250, 150));
    expect(state.dataset.rightOpen).toBe("false");

    await act(() => swipe(part("chat"), 250, 150));
    expect([state.dataset.leftOpen, state.dataset.rightOpen]).toEqual(["false", "true"]);

    await act(() => swipe(part("right"), 150, 250));
    expect([state.dataset.leftOpen, state.dataset.rightOpen]).toEqual(["false", "false"]);

    await act(() => swipe(part("chat"), 150, 250));
    expect([state.dataset.leftOpen, state.dataset.rightOpen]).toEqual(["true", "false"]);

    await act(() => swipe(part("left"), 250, 150));
    expect([state.dataset.leftOpen, state.dataset.rightOpen]).toEqual(["false", "false"]);
  });

  it("delivers a tap's click after tiny horizontal drift", async () => {
    await using screen = await render(<SheetHarness />, {
      router: false /* isolated gesture harness */,
    });
    const state = screen.container.firstElementChild as HTMLElement;
    const button = document.querySelector("[data-slot='sheet-popup'] button") as HTMLElement;
    await act(() => {
      touch(button, "touchstart", 150, 200);
      expect(touch(button, "touchmove", 152, 200).defaultPrevented).toBe(false);
      touch(button, "touchend", 152, 200, true);
      button.click();
    });
    expect(state.dataset.clicks).toBe("1");
    expect(state.dataset.open).toBe("true");
  });

  it("leaves code scrolling to the open tray and swallows the click after a close", async () => {
    await using screen = await render(<SheetHarness />, {
      router: false /* isolated gesture harness */,
    });
    const state = screen.container.firstElementChild as HTMLElement;
    const code = document.querySelector("[data-slot='sheet-popup'] code") as HTMLElement;
    expect(code.parentElement!.scrollWidth).toBeGreaterThan(code.parentElement!.clientWidth + 1);
    await act(() => {
      touch(code, "touchstart", 150, 200);
      expect(touch(code, "touchmove", 250, 201).defaultPrevented).toBe(false);
      touch(code, "touchend", 250, 201, true);
    });
    expect(state.dataset.open).toBe("true");
    const button = document.querySelector("[data-slot='sheet-popup'] button") as HTMLElement;
    await act(() => {
      swipe(button, 150, 250);
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(state.dataset.open).toBe("false");
    expect(state.dataset.clicks).toBe("0");
  });

  it("allows keyboard activation after a claimed swipe without a trailing click", async () => {
    await using screen = await render(<SheetHarness initiallyOpen={false} />, {
      router: false /* isolated gesture harness */,
    });
    const state = screen.container.firstElementChild as HTMLElement;
    await act(() => swipe(state, 250, 150));
    const button = document.querySelector("[data-slot='sheet-popup'] button") as HTMLElement;
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(state.dataset.clicks).toBe("1");
  });

  it("removes click suppression on unmount", async () => {
    await using screen = await render(<SwipeHarness />, {
      router: false /* isolated gesture harness */,
    });
    await act(() => swipe(screen.container.firstElementChild!, 100, 180));
    await screen.unmount();
    const listener = vi.fn();
    window.addEventListener("click", listener, { once: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    window.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });
});
