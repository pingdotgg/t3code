import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

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
}) {
  return (
    <SidebarProvider defaultOpen={props.defaultOpen ?? true}>
      <Sidebar
        collapsible="offcanvas"
        revealOnHover={props.revealOnHover ?? false}
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
    await userEvent.hover(edge);
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
