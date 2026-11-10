import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./sidebar";

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

    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
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

  it("snaps closed or open in the direction a drag past the minimum width is released", async () => {
    await page.viewport(1280, 800);
    const onResize = vi.fn();
    await using screen = await render(<Harness onResize={onResize} />, {
      router: false /* no routes involved */,
    });
    const container = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"]',
    )!;
    const gap = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: 100 };
    const press = (handle: HTMLElement) =>
      handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 0 }));
    // Waits for each move to render, so the drag sees every step and its direction.
    const move = async (handle: HTMLElement, clientX: number, extent: number) => {
      handle.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX }));
      await vi.waitFor(() => expect(gap.style.width).toBe(`${extent}px`));
    };
    const release = async (handle: HTMLElement, clientX: number) => {
      handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX }));
      await vi.waitFor(() => expect(gap.style.width).toBe(""));
    };
    const rail = screen.container.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    // Tests load no CSS, so read the width each drag starts from instead of assuming one.
    const startWidth = () => Math.min(600, container.getBoundingClientRect().width);

    let width = startWidth();
    press(rail);
    await move(rail, 150 - width, 150);
    await move(rail, 190 - width, 190);
    await release(rail, 190 - width);
    expect(onResize).toHaveBeenLastCalledWith(200);
    expect(container.inert).toBe(false);

    width = startWidth();
    press(rail);
    await move(rail, 150 - width, 150);
    await release(rail, 150 - width);
    await vi.waitFor(() => expect(container.inert).toBe(true));
    expect(onResize).toHaveBeenCalledTimes(1);

    const edge = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-collapsed-edge"]',
    )!;
    const closedWidth = startWidth();
    press(edge);
    await move(edge, 60, 60);
    await move(edge, 40, 40);
    await release(edge, 40);
    expect(container.inert).toBe(true);

    press(edge);
    await move(edge, 30, 30);
    await release(edge, 30);
    await vi.waitFor(() => expect(container.inert).toBe(false));
    expect(onResize).toHaveBeenLastCalledWith(closedWidth);
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
