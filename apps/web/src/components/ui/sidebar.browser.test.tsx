import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CSSProperties } from "react";

import { act, fakeTimers, render } from "../../../test/render";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./sidebar";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "./menu";
import { ensureLocalApi } from "~/localApi";
import "~/index.css";

function CollapseFromInside() {
  const { setOpen } = useSidebar();
  return (
    <button type="button" onClick={() => setOpen(false)}>
      Collapse
    </button>
  );
}

function Harness(props: {
  readonly onResize?: (width: number) => void;
  readonly revealOnHover?: boolean;
  readonly defaultOpen?: boolean;
  readonly panelAnimationDurationMs?: number;
  readonly hoverAnimationDurationMs?: number;
}) {
  return (
    <SidebarProvider
      defaultOpen={props.defaultOpen ?? true}
      data-panel-animations={props.panelAnimationDurationMs ? "true" : "false"}
      style={
        {
          "--panel-animation-duration": `${props.panelAnimationDurationMs ?? 0}ms`,
        } as CSSProperties
      }
    >
      <Sidebar
        collapsible="offcanvas"
        revealOnHover={props.revealOnHover ?? false}
        hoverAnimationDurationMs={props.hoverAnimationDurationMs ?? 0}
        resizable={{
          minWidth: 200,
          maxWidth: 600,
          ...(props.onResize ? { onResize: props.onResize } : {}),
        }}
      >
        <CollapseFromInside />
        <Menu>
          <MenuTrigger>Sidebar menu</MenuTrigger>
          <MenuPopup>
            <MenuItem>Menu action</MenuItem>
          </MenuPopup>
        </Menu>
        <SidebarRail />
      </Sidebar>
      <SidebarTrigger />
      <button type="button" className="fixed left-3 top-80 z-40">
        Turn preview
      </button>
      <button type="button" style={{ position: "fixed", right: 10, top: 100 }}>
        Outside
      </button>
    </SidebarProvider>
  );
}

describe("Sidebar", () => {
  it.each([
    { panel: 0, hover: 200, reduced: false, expected: 200 },
    { panel: 300, hover: 75, reduced: false, expected: 75 },
    { panel: 300, hover: 0, reduced: false, expected: 0 },
    { panel: 0, hover: 200, reduced: true, expected: 0 },
  ])(
    "keeps hover enter/exit at $expected ms with panel=$panel, hover=$hover, reduced=$reduced",
    async ({ panel, hover, reduced, expected }) => {
      await page.viewport(1280, 800);
      const matchMedia = window.matchMedia.bind(window);
      using _media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
        const result = matchMedia(query);
        return query === "(prefers-reduced-motion: reduce)"
          ? Object.defineProperty(result, "matches", { value: reduced })
          : result;
      });
      await using screen = await render(
        <Harness
          defaultOpen={false}
          revealOnHover
          panelAnimationDurationMs={panel}
          hoverAnimationDurationMs={hover}
        />,
        {
          router: false /* no routes involved */,
        },
      );
      using _timers = fakeTimers();
      const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
      const container = sidebar.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
      const gap = sidebar.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
      const edge = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-hover-edge"]')!;
      expect(getComputedStyle(container).transitionDuration).toBe(`${panel / 1000}s`);
      edge.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      await act(() => vi.advanceTimersByTimeAsync(110));
      expect(sidebar.inert).toBe(false);
      expect(getComputedStyle(container).transitionDuration).toBe(`${expected / 1000}s`);
      expect(gap.getBoundingClientRect().width).toBe(0);
      edge.dispatchEvent(
        new PointerEvent("pointerout", {
          bubbles: true,
          pointerType: "mouse",
          relatedTarget: document.body,
        }),
      );
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(sidebar.inert).toBe(true);
      expect(getComputedStyle(container).transitionDuration).toBe(`${expected / 1000}s`);
      const trigger = screen.container.querySelector<HTMLButtonElement>(
        '[data-sidebar="trigger"]',
      )!;
      await act(() => trigger.click());
      expect(sidebar.dataset.state).toBe("expanded");
      expect(getComputedStyle(container).transitionDuration).toBe(`${panel / 1000}s`);
      await act(() => trigger.click());
      expect(sidebar.dataset.state).toBe("collapsed");
      expect(getComputedStyle(container).transitionDuration).toBe(`${panel / 1000}s`);
    },
  );

  it("peeks only for mouse hover, overlays the chat, and keeps the explicit toggle available", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<Harness defaultOpen={false} revealOnHover />, {
      router: false /* no routes involved */,
    });
    using _timers = fakeTimers();
    const edge = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-hover-edge"]')!;
    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    const enter = async (pointerType: string) => {
      edge.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType }));
      await act(() => vi.advanceTimersByTimeAsync(110));
    };
    for (const pointerType of ["touch", "pen"]) {
      await enter(pointerType);
      expect(sidebar.inert).toBe(true);
    }
    await enter("mouse");
    expect(sidebar.inert).toBe(false);
    expect(sidebar.dataset.state).toBe("collapsed");
    expect(sidebar.contains(document.elementFromPoint(20, 325))).toBe(true);
    expect(sidebar.querySelector('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width).toBe(
      0,
    );
    expect(
      sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().left,
    ).toBe(0);
    const rail = sidebar.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    const railBounds = rail.getBoundingClientRect();
    expect(
      rail.contains(document.elementFromPoint(railBounds.left + railBounds.width / 2, 300)),
    ).toBe(true);
    const pointer = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
    };
    rail.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 255 }));
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 350 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sidebar.dataset.state).toBe("collapsed");
    expect(sidebar.querySelector('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width).toBe(
      0,
    );
    expect(
      sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().width,
    ).toBe(351);
    screen.container.querySelector<HTMLButtonElement>('[data-slot="sidebar-trigger"]')!.click();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sidebar.dataset.state).toBe("expanded");
    expect(sidebar.inert).toBe(false);
  });

  it("retains the peek for its popup and context menus, then dismisses on departure", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<Harness defaultOpen={false} revealOnHover />, {
      router: false /* no routes involved */,
    });
    const edge = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-hover-edge"]')!;
    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    await userEvent.hover(edge, {
      position: { x: 2, y: window.innerHeight / 2 - edge.getBoundingClientRect().top },
    });
    await vi.waitFor(() => expect(sidebar.inert).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Sidebar menu" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Menu action" }));
    expect(sidebar.inert).toBe(false);
    await userEvent.keyboard("{Escape}");
    const menu = ensureLocalApi().contextMenu.show([{ id: "action", label: "Context action" }], {
      x: 100,
      y: 100,
    });
    await expect.element(page.getByRole("menuitem", { name: "Context action" })).toBeVisible();
    await userEvent.hover(screen.getByRole("button", { name: "Outside" }));
    expect(sidebar.inert).toBe(false);
    await ensureLocalApi().contextMenu.close();
    await menu;
    await vi.waitFor(() => expect(sidebar.inert).toBe(true));
  });

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
