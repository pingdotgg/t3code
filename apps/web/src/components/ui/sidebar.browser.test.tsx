import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "~/index.css";
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
          collapseOnResize: true,
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
  it("commits drag hiding and edge restoration only on release, with reversal before release", async () => {
    await page.viewport(1280, 800);
    const onResize = vi.fn();
    await using screen = await render(<Harness onResize={onResize} />, {
      router: false /* no routes involved */,
    });
    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    const rail = sidebar.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    const pointer = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      pointerType: "mouse",
    };
    const dispatch = (target: HTMLElement, type: string, clientX: number) =>
      target.dispatchEvent(new PointerEvent(type, { ...pointer, clientX }));
    dispatch(rail, "pointerdown", 255);
    dispatch(rail, "pointermove", 50);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().width,
      ).toBe(200),
    );
    expect(
      sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().left,
    ).toBe(0);
    dispatch(rail, "pointermove", 48);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().right,
      ).toBe(0),
    );
    expect(sidebar.dataset.state).toBe("expanded");
    expect(onResize).not.toHaveBeenCalled();
    dispatch(rail, "pointermove", 280);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().left,
      ).toBe(0),
    );
    dispatch(rail, "pointerup", 280);
    expect(onResize).toHaveBeenLastCalledWith(281);
    expect(sidebar.dataset.state).toBe("expanded");
    dispatch(rail, "pointerdown", 280);
    dispatch(rail, "pointerup", 0);
    await vi.waitFor(() => expect(sidebar.dataset.state).toBe("collapsed"));
    expect(onResize).toHaveBeenLastCalledWith(200);
    expect(sidebar.inert).toBe(true);
    const handle = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-restore-handle"]',
    )!;
    const edge = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-restore-edge"]')!;
    await userEvent.hover(edge);
    const bounds = edge.getBoundingClientRect();
    const startX = bounds.right - 1;
    const endX = startX + 258;
    const y = bounds.top + bounds.height / 2;
    expect(handle.contains(document.elementFromPoint(startX, y))).toBe(true);
    expect(edge.contains(document.elementFromPoint(2, y))).toBe(false);
    dispatch(handle, "pointerdown", startX);
    dispatch(handle, "pointermove", endX);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
      ).toBe(258),
    );
    expect(sidebar.dataset.state).toBe("collapsed");
    expect(
      sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().left,
    ).toBe(0);
    dispatch(handle, "pointermove", startX);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().right,
      ).toBe(0),
    );
    expect(sidebar.querySelector('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width).toBe(
      0,
    );
    dispatch(handle, "pointerup", startX);
    expect(sidebar.dataset.state).toBe("collapsed");
    expect(onResize).toHaveBeenCalledTimes(2);
    dispatch(handle, "pointerdown", startX);
    dispatch(handle, "pointermove", endX);
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().left,
      ).toBe(0),
    );
    dispatch(handle, "pointerup", endX);
    await vi.waitFor(() => expect(sidebar.dataset.state).toBe("expanded"));
    expect(onResize).toHaveBeenLastCalledWith(258);
    expect(sidebar.inert).toBe(false);
  });

  it.each(["pointercancel", "lostpointercapture", "blur"])(
    "abandons hide intent on %s",
    async (eventType) => {
      await page.viewport(1280, 800);
      const onResize = vi.fn();
      await using screen = await render(<Harness onResize={onResize} />, {
        router: false /* no routes involved */,
      });
      const rail = screen.container.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
      const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
      const pointer = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        button: 0,
        pointerType: "mouse",
        clientX: 255,
      };
      rail.dispatchEvent(new PointerEvent("pointerdown", pointer));
      rail.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: 0 }));
      await vi.waitFor(() =>
        expect(
          sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().right,
        ).toBe(0),
      );
      if (eventType === "blur") window.dispatchEvent(new Event("blur"));
      else rail.dispatchEvent(new PointerEvent(eventType, { ...pointer, clientX: 0 }));
      rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 0 }));
      expect(sidebar.dataset.state).toBe("expanded");
      expect(onResize).not.toHaveBeenCalled();
      expect(
        sidebar.querySelector('[data-slot="sidebar-container"]')!.getBoundingClientRect().left,
      ).toBe(0);
    },
  );
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
