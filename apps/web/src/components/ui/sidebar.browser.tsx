import "../../index.css";

import type { CSSProperties } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

const INITIAL_SIDEBAR_WIDTH_PX = 360;
const SIDEBAR_MIN_WIDTH_PX = 280;

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await waitForLayout();
}

function parseSidebarWidth(wrapper: HTMLElement): number {
  const width = Number.parseFloat(wrapper.style.getPropertyValue("--sidebar-width"));
  if (!Number.isFinite(width)) {
    throw new Error("Expected sidebar wrapper to expose a numeric --sidebar-width.");
  }
  return width;
}

function dispatchPointerEvent(target: EventTarget, type: string, init: PointerEventInit): boolean {
  return target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerType: "mouse",
      ...init,
    }),
  );
}

function stubPointerCapture(rail: HTMLButtonElement) {
  let capturedPointerId: number | null = null;

  rail.setPointerCapture = (pointerId: number) => {
    capturedPointerId = pointerId;
  };
  rail.releasePointerCapture = (pointerId: number) => {
    if (capturedPointerId === pointerId) {
      capturedPointerId = null;
    }
  };
  rail.hasPointerCapture = (pointerId: number) => capturedPointerId === pointerId;
}

async function mountSidebarHarness(side: "left" | "right" = "right") {
  await setViewport(1280, 800);

  const host = document.createElement("div");
  document.body.append(host);
  const onResize = vi.fn();

  const sidebar = (
    <SidebarProvider
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": `${INITIAL_SIDEBAR_WIDTH_PX}px` } as CSSProperties}
      defaultOpen
    >
      <Sidebar
        side={side}
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: SIDEBAR_MIN_WIDTH_PX,
          onResize,
        }}
      >
        <div className="h-full p-4">Diff panel content</div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
  const mainPane = (
    <main
      className="min-w-0 flex-1 overflow-y-scroll border-r border-dashed border-border/60"
      data-testid="main-scroll-pane"
    >
      <div className="min-h-[200vh] p-6">
        <p>Main pane content</p>
      </div>
    </main>
  );

  const screen = await render(
    <div className="fixed inset-0 flex overflow-hidden bg-background text-foreground">
      {side === "left" ? sidebar : mainPane}
      {side === "left" ? mainPane : sidebar}
    </div>,
    { container: host },
  );
  await waitForLayout();

  return {
    onResize,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function getMainPaneEdgeX(mainRect: DOMRect, side: "left" | "right"): number {
  return side === "right" ? mainRect.right - 2 : mainRect.left + 2;
}

function getResizeDeltaX(side: "left" | "right"): number {
  return side === "right" ? -80 : 80;
}

describe("SidebarRail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  for (const side of ["left", "right"] as const) {
    it(`keeps the expanded ${side} rail off the main pane edge hit target`, async () => {
      const mounted = await mountSidebarHarness(side);

      try {
        await expect.element(page.getByLabelText("Resize Sidebar")).toBeVisible();

        await vi.waitFor(() => {
          const mainPane = document.querySelector<HTMLElement>('[data-testid="main-scroll-pane"]');
          const rail = document.querySelector<HTMLElement>("[data-slot='sidebar-rail']");
          if (!mainPane || !rail) {
            throw new Error("Expected the main pane and sidebar rail to be mounted.");
          }

          const mainRect = mainPane.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            getMainPaneEdgeX(mainRect, side),
            mainRect.top + mainRect.height / 2,
          );

          expect(hitTarget).not.toBeNull();
          expect(hitTarget instanceof Element && rail.contains(hitTarget)).toBe(false);
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it(`still resizes an expanded ${side} sidebar from inside the panel edge`, async () => {
      const mounted = await mountSidebarHarness(side);

      try {
        await expect.element(page.getByLabelText("Resize Sidebar")).toBeVisible();

        const rail = await vi.waitFor(() => {
          const element = document.querySelector<HTMLButtonElement>("[data-slot='sidebar-rail']");
          if (!element) {
            throw new Error("Expected the sidebar rail to be mounted.");
          }
          return element;
        });
        const wrapper = await vi.waitFor(() => {
          const element = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']");
          if (!element) {
            throw new Error("Expected the sidebar wrapper to be mounted.");
          }
          return element;
        });
        const sidebarContainer = await vi.waitFor(() => {
          const element = document.querySelector<HTMLElement>("[data-slot='sidebar-container']");
          if (!element) {
            throw new Error("Expected the sidebar container to be mounted.");
          }
          if (element.getBoundingClientRect().width <= 0) {
            throw new Error("Expected the sidebar container to have a measurable width.");
          }
          return element;
        });

        stubPointerCapture(rail);

        const initialWidth = sidebarContainer.getBoundingClientRect().width;
        const railRect = rail.getBoundingClientRect();
        const startX = railRect.left + railRect.width / 2;
        const startY = railRect.top + railRect.height / 2;
        const resizeDeltaX = getResizeDeltaX(side);

        dispatchPointerEvent(rail, "pointerdown", {
          button: 0,
          clientX: startX,
          clientY: startY,
          pointerId: 1,
        });
        dispatchPointerEvent(rail, "pointermove", {
          clientX: startX + resizeDeltaX,
          clientY: startY,
          pointerId: 1,
        });

        await vi.waitFor(() => {
          expect(parseSidebarWidth(wrapper)).toBeGreaterThan(initialWidth);
        });

        dispatchPointerEvent(rail, "pointerup", {
          button: 0,
          clientX: startX + resizeDeltaX,
          clientY: startY,
          pointerId: 1,
        });

        await vi.waitFor(() => {
          expect(mounted.onResize).toHaveBeenCalled();
          const nextWidth = mounted.onResize.mock.calls.at(-1)?.[0];
          expect(typeof nextWidth).toBe("number");
          expect(nextWidth).toBeGreaterThan(initialWidth);
        });
      } finally {
        await mounted.cleanup();
      }
    });
  }
});
