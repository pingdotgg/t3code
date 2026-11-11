import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useLayoutBehaviorStore } from "./layoutBehavior";
import { settleStripCamera } from "../motion/stripCamera";
import { createLayoutLauncherContent, createLayoutState, selectFocusedTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutSurfaceHost } from "./SurfaceHost";

const TOUR_KEY = "t3code:layout-tour:v1";

function setup() {
  const settings = getClientSettings();
  const behavior = useLayoutBehaviorStore.getState().behavior;
  __setClientSettingsForTests({ ...settings, scrollingWorkspacesEnabled: true });
  const original = useLayoutStore.getState().layout;
  const tour = localStorage.getItem(TOUR_KEY);
  localStorage.setItem(TOUR_KEY, "true");
  useLayoutStore.setState({ layout: createLayoutState() });
  const store = useLayoutStore.getState();
  store.openTab(createLayoutLauncherContent(null), { placement: "active-pane" });
  store.openTab(createLayoutLauncherContent(null), { placement: "new-column" });
  store.openTab(createLayoutLauncherContent(null), { placement: "active-pane" });
  store.openTab(createLayoutLauncherContent(null), { placement: "new-column" });
  const layout = useLayoutStore.getState().layout;
  const workspace = layout.workspaces[0]!;
  const columns = workspace.columns.map((column) => ({ ...column, width: 2 / 3 }));
  const [second] = columns[1]!.panes[0]!.tabs;
  useLayoutStore.setState({
    layout: {
      ...layout,
      workspaces: [{ ...workspace, columns, focusedPaneId: columns[0]!.panes[0]!.id }],
    },
  });
  return {
    second: second!,
    [Symbol.dispose]: () => {
      __setClientSettingsForTests(settings);
      useLayoutBehaviorStore.setState({ behavior });
      useLayoutStore.setState({ layout: original });
      if (tour === null) localStorage.removeItem(TOUR_KEY);
      else localStorage.setItem(TOUR_KEY, tour);
    },
  };
}

function Host() {
  const layout = useLayoutStore((state) => state.layout);
  return <LayoutSurfaceHost layout={layout} />;
}

async function renderHost() {
  await page.viewport(900, 600);
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;display:flex;";
  return render(<Host />, { container });
}

const focusedTabId = () => selectFocusedTab(useLayoutStore.getState().layout)?.id;

const inSecondPane = (selector: string) => {
  const paneId = useLayoutStore.getState().layout.workspaces[0]!.columns[1]!.panes[0]!.id;
  return document.querySelector<HTMLElement>(`[data-layout-pane-id="${paneId}"] ${selector}`)!;
};

async function clickHeld(element: HTMLElement) {
  const strip = document.querySelector<HTMLElement>("[data-layout-strip]")!;
  const held = strip.scrollLeft;
  const pointer = { bubbles: true, button: 0, pointerType: "mouse" } as const;
  element.dispatchEvent(new PointerEvent("pointerdown", pointer));
  await expect
    .element(page.elementLocator(element.closest("[data-layout-pane-id]")!))
    .toHaveAttribute("data-layout-pane-focused", "true");
  expect(strip.scrollLeft).toBe(held);
  element.dispatchEvent(new PointerEvent("pointerup", pointer));
  await page.elementLocator(element).click();
  await vi.waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(held));
}

it("shows a tab in an unfocused pane that runs off screen with one click on it", async () => {
  using tabs = setup();
  await using _screen = await renderHost();
  await clickHeld(inSecondPane(`[data-layout-pane-tab="${tabs.second.id}"]`));
  await vi.waitFor(() => expect(focusedTabId()).toBe(tabs.second.id));
});

const columnWidths = () =>
  useLayoutStore.getState().layout.workspaces[0]!.columns.map((column) => column.width);

it("resizes each column from the edge grabbed, in either direction, without moving its neighbors", async () => {
  using _tabs = setup();
  await using _screen = await renderHost();
  const strip = document.querySelector<HTMLElement>("[data-layout-strip]")!;
  const drag = async (label: string, index: number, travel: number) => {
    settleStripCamera();
    const handle = document.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)[index]!;
    const rect = handle.getBoundingClientRect();
    const view = strip.getBoundingClientRect();
    // The middle of its on-screen part: the last column's end straddles the window edge.
    const x = (Math.max(rect.left, view.left) + Math.min(rect.right, view.right)) / 2;
    const y = rect.top + rect.height / 2;
    // Press where the page hit-tests, so a pane or overlay covering the handle fails here.
    const hit = document.elementFromPoint(x, y);
    expect(hit).toBe(handle);
    const pointer = (clientX: number) =>
      ({
        bubbles: true,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        clientX,
        clientY: y,
      }) as const;
    hit!.dispatchEvent(new PointerEvent("pointerdown", pointer(x)));
    hit!.dispatchEvent(new PointerEvent("pointermove", pointer(x + travel / 2)));
    hit!.dispatchEvent(new PointerEvent("pointermove", pointer(x + travel)));
    // A hand releases frames after pressing, once the drag shows.
    await vi.waitFor(() => expect(hit!.hasAttribute("data-dragging")).toBe(true));
    hit!.dispatchEvent(new PointerEvent("pointerup", pointer(x + travel)));
  };
  const expectWidths = async (expected: number[]) =>
    vi.waitFor(() =>
      columnWidths().forEach((width, index) => expect(width).toBeCloseTo(expected[index]!, 3)),
    );
  const widths = columnWidths();
  expect(widths).toHaveLength(3);

  // Both halves of the first gap: the left half shrinks and grows the first column...
  await drag("Resize column", 0, -90);
  widths[0]! -= 90 / 900;
  await expectWidths(widths);

  // ...and the right half shrinks the second with the strip already at its start...
  expect(strip.scrollLeft).toBe(0);
  await drag("Resize column start", 0, 60);
  widths[1]! -= 60 / 900;
  await expectWidths(widths);
  await vi.waitFor(() => expect(strip.scrollLeft).toBe(150));

  // ...or grows it leftward while keeping the whole resized column visible on release.
  const beforeGrow = strip.scrollLeft;
  await drag("Resize column start", 0, -150);
  widths[1]! += 150 / 900;
  await expectWidths(widths);
  await vi.waitFor(() => expect(strip.scrollLeft).toBeCloseTo(beforeGrow + 150, 0));

  await drag("Resize column", 0, 45);
  widths[0]! += 45 / 900;
  await expectWidths(widths);

  // At the strip's end, the middle column grows without shrinking the last, which shrinks
  // from the half of its end edge left inside the window.
  const scrollToEnd = async () => {
    settleStripCamera();
    strip.scrollTo({ left: strip.scrollWidth, behavior: "instant" });
    await vi.waitFor(() => expect(strip.scrollLeft).toBe(strip.scrollWidth - strip.clientWidth));
  };
  await scrollToEnd();
  await drag("Resize column", 1, 45);
  widths[1]! += 45 / 900;
  await expectWidths(widths);
  await scrollToEnd();
  await drag("Resize column", 2, -90);
  widths[2]! -= 90 / 900;
  await expectWidths(widths);
});

it("scrolls the strip sideways on a Shift+wheel that only reports vertical travel", async () => {
  using _tabs = setup();
  await using _screen = await renderHost();
  const strip = document.querySelector<HTMLElement>("[data-layout-strip]")!;
  const paneId = useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.panes[0]!.id;
  const pane = document.querySelector<HTMLElement>(`[data-layout-pane-id="${paneId}"]`)!;
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    shiftKey: true,
    deltaY: 120,
  });
  pane.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(strip.scrollLeft).toBe(120);
});

const strip = () => document.querySelector<HTMLElement>("[data-layout-strip]")!;
const paneRect = (column: number) => {
  const paneId = useLayoutStore.getState().layout.workspaces[0]!.columns[column]!.panes[0]!.id;
  const shown = [...document.querySelectorAll(`[data-layout-pane-id="${paneId}"]`)].find((pane) =>
    pane.checkVisibility(),
  );
  return shown!.getBoundingClientRect();
};
const focusedColumn = () => {
  const workspace = useLayoutStore.getState().layout.workspaces[0]!;
  return workspace.columns.findIndex((column) =>
    column.panes.some((pane) => pane.id === workspace.focusedPaneId),
  );
};
const scrollStripTo = async (left: number) => {
  strip().scrollTo({ left, behavior: "instant" });
  const landed = Math.min(left, strip().scrollWidth - strip().clientWidth);
  await vi.waitFor(() => expect(strip().scrollLeft).toBe(landed));
};
const targetShown = (handle: Element) =>
  getComputedStyle(handle.querySelector("[data-resize-target]")!).opacity;

/** Presses the element the page hit-tests at (x, y), moves through `path` and releases there. */
function dragFrom(x: number, y: number, path: number[], release = true) {
  const hit = document.elementFromPoint(x, y) as HTMLElement;
  const pointer = (clientX: number) =>
    ({
      bubbles: true,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX,
      clientY: y,
    }) as const;
  hit.dispatchEvent(new PointerEvent("pointerdown", pointer(x)));
  for (const to of path) hit.dispatchEvent(new PointerEvent("pointermove", pointer(to)));
  if (release) hit.dispatchEvent(new PointerEvent("pointerup", pointer(path.at(-1) ?? x)));
  return {
    hit,
    release: (to: number) => hit.dispatchEvent(new PointerEvent("pointerup", pointer(to))),
  };
}

it("grows the last column from just inside its left edge, highlighting that edge first", async () => {
  using _tabs = setup();
  await using _screen = await renderHost();
  useLayoutStore
    .getState()
    .focusPane(useLayoutStore.getState().layout.workspaces[0]!.columns[2]!.panes[0]!.id);
  await vi.waitFor(() =>
    expect(paneRect(2).right).toBeCloseTo(strip().getBoundingClientRect().right, 0),
  );
  settleStripCamera();
  await scrollStripTo(strip().scrollWidth - strip().clientWidth - 60);
  const widths = columnWidths();
  const last = paneRect(2);
  const x = last.left + 2;
  const y = last.top + last.height / 2;
  const handle = document.elementFromPoint(x, y) as HTMLElement;
  expect(handle.getAttribute("aria-label")).toBe("Resize column start");
  const neighborEnd = document.querySelectorAll('[aria-label="Resize column"]')[1]!;

  // Hover shows only the edge this press would move, not the neighbor's half of the gutter.
  const box = handle.getBoundingClientRect();
  await userEvent.hover(handle, { position: { x: x - box.left, y: y - box.top } });
  await vi.waitFor(() => expect(targetShown(handle)).toBe("1"));
  expect(targetShown(neighborEnd)).toBe("0");

  const scrolled = strip().scrollLeft;
  const { release } = dragFrom(x, y, [x - 75, x - 150], false);
  await vi.waitFor(() => expect(handle.hasAttribute("data-dragging")).toBe(true));
  release(x - 150);
  widths[2]! += 150 / 900;
  await vi.waitFor(() =>
    columnWidths().forEach((width, index) => expect(width).toBeCloseTo(widths[index]!, 3)),
  );
  // Release reveals the previously clipped end of the already-focused column.
  await vi.waitFor(() => expect(strip().scrollLeft).toBeCloseTo(scrolled + 150 + 60, 0));
  expect(focusedColumn()).toBe(2);
  await vi.waitFor(() =>
    expect(paneRect(2).right).toBeCloseTo(strip().getBoundingClientRect().right, 0),
  );
  expect(handle.hasAttribute("data-dragging")).toBe(false);

  // Leaving for the pane's content drops the highlight.
  const grown = paneRect(2);
  await userEvent.hover(document.elementFromPoint(grown.left + 80, y)!);
  await vi.waitFor(() => expect(targetShown(handle)).toBe("0"));
});

it("keeps growing a column held at the strip's edge, up to the window's width", async () => {
  using _tabs = setup();
  await using _screen = await renderHost();
  await scrollStripTo(450);
  const view = strip().getBoundingClientRect();
  // The middle column's start 150px into the window, its end 150px short of the right edge.
  await vi.waitFor(() => expect(paneRect(1).left).toBeCloseTo(view.left + 154, 0));
  const widths = columnWidths();
  const middle = paneRect(1);
  const y = middle.top + middle.height / 2;
  const { hit, release } = dragFrom(middle.left + 2, y, [view.left + 4], false);
  expect(hit.getAttribute("aria-label")).toBe("Resize column start");
  await vi.waitFor(() => expect(paneRect(1).width).toBeGreaterThan(view.width - 10));
  release(view.left + 4);
  widths[1] = 1;
  await vi.waitFor(() =>
    columnWidths().forEach((width, index) => expect(width).toBeCloseTo(widths[index]!, 3)),
  );
});

it("moves focus to the neighboring column on a double-click in the gutter on that side", async () => {
  using _tabs = setup();
  await using _screen = await renderHost();
  const widths = columnWidths();
  const doubleClickAt = async (x: number) => {
    const y = paneRect(0).top + paneRect(0).height / 2;
    const gutter = document.elementFromPoint(x, y) as HTMLElement;
    expect(gutter.hasAttribute("data-layout-gutter")).toBe(true);
    const box = gutter.getBoundingClientRect();
    await userEvent.dblClick(gutter, { position: { x: x - box.left, y: y - box.top } });
  };

  // Right of the focused first column: the second takes focus and comes on screen.
  await doubleClickAt(paneRect(0).right + 2);
  await vi.waitFor(() => expect(focusedColumn()).toBe(1));
  await vi.waitFor(() =>
    expect(paneRect(1).right).toBeLessThanOrEqual(strip().getBoundingClientRect().right),
  );

  // Left of it, back to the first.
  await doubleClickAt(paneRect(1).left - 2);
  await vi.waitFor(() => expect(focusedColumn()).toBe(0));
  await vi.waitFor(() => expect(strip().scrollLeft).toBe(0));

  // Past the last column there is nothing further: focus stays.
  useLayoutStore
    .getState()
    .focusPane(useLayoutStore.getState().layout.workspaces[0]!.columns[2]!.panes[0]!.id);
  await vi.waitFor(() =>
    expect(paneRect(2).right).toBeCloseTo(strip().getBoundingClientRect().right, 0),
  );
  await doubleClickAt(strip().getBoundingClientRect().right - 2);
  expect(focusedColumn()).toBe(2);
  // Pressing a gutter's handle without moving it resizes nothing.
  expect(columnWidths()).toEqual(widths);
});
