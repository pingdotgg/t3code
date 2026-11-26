import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { flushSync } from "react-dom";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import {
  fileSurface,
  hostRightPanel,
  pullRequestSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import { useLayoutBehaviorStore } from "./layoutBehavior";
import { focusAdjacentLayoutTab } from "./layoutActions";
import {
  commitLayoutDrop,
  isLayoutDragActive,
  isLayoutDropUseful,
  type LayoutDragSource,
  type LayoutDragSurface,
} from "./layoutDrag";
import {
  createLayoutLauncherContent,
  createLayoutState,
  createLayoutTab,
  findLayoutChatForThread,
  findLayoutSurfaceTabs,
  LAYOUT_READABLE_COLUMN_PX,
  selectFocusedTab,
  type LayoutColumn,
  type LayoutTab,
} from "./layoutModel";
import {
  readableLayoutColumnShare,
  setLayoutStripViewportWidth,
  useLayoutStore,
} from "./layoutStore";
import { LayoutDropZones } from "./DropZones";
import { LayoutSurfaceHost, selectSurfaceMounts } from "./SurfaceHost";
import { requestLayoutSurfacePlacement, useLayoutSurfaceSync } from "./surfaceSync";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

const TOUR_KEY = "t3code:layout-tour:v1";

function setup(columnWidth = 2 / 3) {
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
  const layout = useLayoutStore.getState().layout;
  const workspace = layout.workspaces[0]!;
  const columns = workspace.columns.map((column) => ({ ...column, width: columnWidth }));
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

async function renderHost({ insetSidebar = false, edges = [0, 0], viewport = 900 } = {}) {
  await page.viewport(viewport, 600);
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;inset:0;display:flex;padding:0 ${edges[1]}px 0 ${edges[0]}px;`;
  // The pane chrome (index.css) styles an inset that follows the app's inset sidebar.
  const sidebar = insetSidebar ? <div data-slot="sidebar" data-variant="inset" hidden /> : null;
  return render(
    <>
      {sidebar}
      <div
        data-sidebar-gap=""
        style={{ flex: "none", width: 0, transition: "width 150ms ease-out" }}
      />
      <Host />
    </>,
    { container },
  );
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
  element.click();
  await vi.waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(held));
}

it("shows a tab in an unfocused pane that runs off screen with one click on it", async () => {
  using tabs = setup();
  await using _screen = await renderHost();
  await clickHeld(inSecondPane(`[data-layout-pane-tab="${tabs.second.id}"]`));
  await vi.waitFor(() => expect(focusedTabId()).toBe(tabs.second.id));
});

async function renderStrip({
  edges = [0, 0],
  viewport = 900,
  camera = 900,
  columnWidth = 2 / 3,
} = {}) {
  setLayoutStripViewportWidth(camera);
  await using stack = new AsyncDisposableStack();
  stack.use(setup(columnWidth));
  const screen = stack.use(await renderHost({ edges, viewport }));
  const strip = screen.container.querySelector<HTMLElement>("[data-layout-strip]")!;
  const gap = screen.container.querySelector<HTMLElement>("[data-sidebar-gap]")!;
  const settled = async (width: number) => {
    await vi.waitFor(() =>
      expect(Math.abs(gap.getBoundingClientRect().width - width)).toBeLessThan(0.02),
    );
    await vi.waitFor(() =>
      expect(readableLayoutColumnShare()).toBe(LAYOUT_READABLE_COLUMN_PX / strip.clientWidth),
    );
  };
  await settled(0);
  await vi.waitFor(() => expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth + 100));
  const pane = inSecondPane("[data-pane-header]").closest<HTMLElement>("[data-layout-pane-id]")!;
  const paneLeft = () => pane.getBoundingClientRect().left;
  const seen: number[] = [];
  const sample = () => seen.push(paneLeft());
  const observer = new ResizeObserver(sample);
  observer.observe(strip);
  stack.defer(() => observer.disconnect());
  const scrollTo = async (left: number) => {
    strip.scrollLeft = left;
    await vi.waitFor(() => expect(strip.scrollLeft).toBe(left));
    await vi.waitFor(() =>
      expect(paneLeft()).toBeCloseTo(
        strip.getBoundingClientRect().left + pane.offsetLeft - strip.scrollLeft,
        3,
      ),
    );
    seen.length = 0;
  };
  const toggle = async (width: number) => {
    gap.style.width = `${width}px`;
    await settled(width);
  };
  const owned = stack.move();
  return {
    strip,
    gap,
    seen,
    paneLeft,
    scrollTo,
    toggle,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

const STILL = 0.01;

it.each([
  ["at the strip's end", 247.6, 1, [0, 0]],
  ["midway along the strip", 247.6, 0.5, [0, 0]],
  ["at the strip's end beside a resized sidebar", 300.5, 1, [0, 0]],
  ["midway along the strip beside a resized sidebar", 300.5, 0.6, [0, 0]],
  ["at the end of a strip with fractional edges", 256, 1, [9.25, 0.3]],
  ["at the end of a strip with fractional edges beside a resized sidebar", 247.5, 1, [8.5, 9.4]],
])(
  "keeps the panes in place on screen while the sidebar opens and closes %s",
  async (_, sidebar, along, edges) => {
    await using host = await renderStrip({ edges });
    const { strip } = host;
    await host.scrollTo(Math.round((strip.scrollWidth - strip.clientWidth) * along));
    const resting = host.paneLeft();
    for (let cycle = 0; cycle < 3; cycle++) {
      await host.toggle(sidebar);
      expect(host.paneLeft()).toBeCloseTo(resting, 2);
      await host.toggle(0);
      expect(host.paneLeft()).toBeCloseTo(resting, 2);
    }
    expect(host.seen.length).toBeGreaterThan(6);
    for (const left of host.seen) expect(Math.abs(left - resting)).toBeLessThan(STILL);
  },
);

it("keeps the panes in place when the host renders while the sidebar slides", async () => {
  await using host = await renderStrip();
  await host.scrollTo(host.strip.scrollWidth - host.strip.clientWidth);
  const resting = host.paneLeft();
  let renders = 0;
  const rerender = new ResizeObserver(() => {
    if (renders++ > 2) return;
    flushSync(() => useLayoutStore.setState({ layout: { ...useLayoutStore.getState().layout } }));
    host.seen.push(host.paneLeft());
  });
  rerender.observe(host.strip);
  try {
    await host.toggle(256);
    await host.toggle(0);
  } finally {
    rerender.disconnect();
  }
  expect(renders).toBeGreaterThan(2);
  expect(host.paneLeft()).toBeCloseTo(resting, 2);
  for (const left of host.seen) expect(Math.abs(left - resting)).toBeLessThan(STILL);
});

it.each([
  ["a width that rounds the focused span down", 1134],
  ["another width that rounds it down", 1162],
  ["a width that keeps its rounding", 1158],
])("keeps the strip where it is when it settles at %s", async (_, width) => {
  const viewport = 1440;
  await using host = await renderStrip({ viewport, camera: 1094, columnWidth: 0.75 });
  await host.toggle(viewport - 1174);
  await host.scrollTo(host.strip.scrollWidth - host.strip.clientWidth);
  const resting = host.paneLeft();
  const before = host.strip.scrollLeft;
  await host.toggle(viewport - width);
  expect(host.strip.clientWidth).toBe(width);
  expect(host.strip.scrollLeft).toBe(before + 1174 - width);
  expect(host.paneLeft()).toBeCloseTo(resting, 2);
  for (const left of host.seen) expect(Math.abs(left - resting)).toBeLessThan(STILL);
});

it("gives a scroll back after closing the sidebar had to clamp it", async () => {
  await using host = await renderStrip();
  await host.toggle(300.5);
  await host.scrollTo(100);
  const resting = host.paneLeft();
  for (let cycle = 0; cycle < 2; cycle++) {
    await host.toggle(0);
    expect(host.strip.scrollLeft).toBe(0);
    await host.toggle(300.5);
    expect(host.paneLeft()).toBeCloseTo(resting, 2);
  }
});

it("keeps the panes in place when the sidebar reopens before it has closed", async () => {
  await using host = await renderStrip();
  await host.toggle(300.5);
  await host.scrollTo(host.strip.scrollWidth - host.strip.clientWidth);
  const resting = host.paneLeft();
  host.gap.style.width = "0px";
  await vi.waitFor(() => expect(host.seen.length).toBeGreaterThan(3));
  await host.toggle(300.5);
  expect(host.paneLeft()).toBeCloseTo(resting, 2);
  for (const left of host.seen) expect(Math.abs(left - resting)).toBeLessThan(STILL);
});

const secondPaneStrip = () => inSecondPane("[data-layout-tab-strip]");
const joinOffset = (strip: HTMLElement) =>
  strip
    .closest("[data-layout-tab-strip-slot]")!
    .querySelector<HTMLElement>("[data-pane-join]")!
    .style.getPropertyValue("--jx");
const tabOffset = (strip: HTMLElement, tabId: string) => {
  const tab = strip.querySelector<HTMLElement>(`[data-layout-pane-tab="${tabId}"]`)!;
  const left = tab.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  return `${Math.round(left + strip.scrollLeft)}px`;
};

it("scrolls overflowing pane tabs from the add button without moving the workspace", async () => {
  using _tabs = setup();
  for (let index = 0; index < 12; index++) {
    useLayoutStore
      .getState()
      .openTab(createLayoutLauncherContent(null), { placement: "active-pane" });
  }
  await using screen = await renderHost({ insetSidebar: true });
  const strip = screen.container.querySelector<HTMLElement>("[data-layout-tab-strip]")!;
  const header = strip.closest<HTMLElement>("[data-pane-header]")!;
  const workspace = screen.container.querySelector<HTMLElement>("[data-layout-strip]")!;
  await vi.waitFor(() => expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth + 200));
  const startChevron = header.querySelector<HTMLButtonElement>(
    '[data-strip-scroll-button="start"]',
  );
  const endChevron = header.querySelector<HTMLButtonElement>('[data-strip-scroll-button="end"]');
  expect(startChevron).not.toBeNull();
  expect(endChevron).not.toBeNull();
  // Scroll to 0: start chevron is disabled, end chevron is enabled and clicking it advances the strip.
  strip.scrollLeft = 0;
  await vi.waitFor(() => {
    expect(startChevron!.getAttribute("aria-disabled")).toBe("true");
    expect(endChevron!.hasAttribute("data-can-scroll")).toBe(true);
  });
  expect(getComputedStyle(endChevron!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(strip).overscrollBehaviorX).toBe("contain");
  const siblingStrip = [
    ...document.querySelectorAll<HTMLElement>("[data-layout-tab-strip]"),
  ].find((candidate) => candidate !== strip);
  expect(siblingStrip && getComputedStyle(siblingStrip).overscrollBehaviorX).toBe("auto");
  endChevron!.click();
  await vi.waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(0));
  await vi.waitFor(() => expect(startChevron!.hasAttribute("data-can-scroll")).toBe(true));
  // Scroll all the way to the end: end chevron disables, extra click leaves scroll at max.
  const maxScroll = strip.scrollWidth - strip.clientWidth;
  strip.scrollLeft = maxScroll;
  await vi.waitFor(() => expect(endChevron!.getAttribute("aria-disabled")).toBe("true"));
  endChevron!.click();
  expect(Math.round(strip.scrollLeft)).toBe(maxScroll);
  // Start chevron scrolls back toward 0.
  startChevron!.click();
  await vi.waitFor(() => expect(strip.scrollLeft).toBeLessThan(maxScroll));
  strip.scrollLeft = 100;
  const stripBox = strip.getBoundingClientRect();
  const revealed = strip.scrollLeft;
  header.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: -30,
      clientX: stripBox.left + stripBox.width / 2,
      clientY: stripBox.top + stripBox.height / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(strip.scrollLeft).toBe(revealed - 30);
  // At the left edge nothing moves, so a vertical wheel is not swallowed; buttons skip measuring.
  strip.scrollLeft = 0;
  const atEdge = new WheelEvent("wheel", {
    deltaY: -30,
    clientX: stripBox.left + stripBox.width / 2,
    clientY: stripBox.top + stripBox.height / 2,
    bubbles: true,
    cancelable: true,
  });
  header.dispatchEvent(atEdge);
  expect(atEdge.defaultPrevented).toBe(false);
  using stripMeasure = vi.spyOn(strip, "getBoundingClientRect");
  header
    .querySelector('button[aria-label="New tab"]')!
    .dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true, cancelable: true }));
  expect(stripMeasure).not.toHaveBeenCalled();
  strip.scrollLeft = 100;
  const before = workspace.scrollLeft;

  await userEvent.wheel(header.querySelector('button[aria-label="New tab"]')!, {
    delta: { x: 40 },
  });

  await vi.waitFor(() => expect(strip.scrollLeft).toBe(140));
  expect(workspace.scrollLeft).toBe(before);
  const active = strip.querySelector<HTMLElement>("[data-joined]")!;
  expect(joinOffset(strip)).toBe(tabOffset(strip, active.dataset.layoutPaneTab!));

  const closed = strip.querySelector<HTMLElement>("[data-layout-pane-tab]")!;
  const joinedAt = joinOffset(strip);
  useLayoutStore.getState().closeTab(closed.dataset.layoutPaneTab!);
  await vi.waitFor(() => expect(joinOffset(strip)).not.toBe(joinedAt));
  expect(strip.scrollLeft).toBe(140);

  const overflowEnd = strip.style.getPropertyValue("--strip-overflow-end");
  strip.style.maxWidth = `${strip.offsetWidth - 40}px`;
  await vi.waitFor(() =>
    expect(strip.style.getPropertyValue("--strip-overflow-end")).not.toBe(overflowEnd),
  );
  expect(strip.scrollLeft).toBe(140);
  strip.style.removeProperty("max-width");

  const tabIds = [...strip.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")].map(
    (tab) => tab.dataset.layoutPaneTab!,
  );
  const middle = tabIds[Math.floor(tabIds.length / 2)]!;
  useLayoutStore.getState().focusTab(middle);
  await vi.waitFor(() => expect(joinOffset(strip)).toBe(tabOffset(strip, middle)));
  const held = Number.parseFloat(tabOffset(strip, middle)) - 100;
  strip.scrollLeft = held;
  await vi.waitFor(() =>
    expect(strip.style.getPropertyValue("--strip-overflow-start")).toBe(`${held}px`),
  );
  useLayoutStore.getState().closeTab(middle);
  await vi.waitFor(() => {
    const next = focusedTabId()!;
    expect(next).not.toBe(middle);
    expect(joinOffset(strip)).toBe(tabOffset(strip, next));
  });
  expect(strip.scrollLeft).toBe(held);

  await userEvent.wheel(
    strip.closest("[data-pane-header]")!.querySelector('button[aria-label="New tab"]')!,
    { delta: { x: -held } },
  );
  await vi.waitFor(() => expect(strip.scrollLeft).toBe(0));
  const tabs = [...strip.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")];
  for (const tab of tabs) {
    if (tab !== active) useLayoutStore.getState().closeTab(tab.dataset.layoutPaneTab!);
  }
  await vi.waitFor(() => expect(strip.scrollWidth).toBe(strip.clientWidth));
  await vi.waitFor(() =>
    expect(strip.closest("[data-pane-header]")?.hasAttribute("data-tab-row-overflow")).toBe(false),
  );
  expect(getComputedStyle(strip).overscrollBehaviorX).toBe("auto");
  await vi.waitFor(() =>
    expect(
      strip.closest("[data-pane-header]")?.querySelectorAll("[data-strip-scroll-button]").length,
    ).toBe(0),
  );
});

it("keeps a pane's tab strip and moves its joined tab when the pane switches tabs", async () => {
  using tabs = setup();
  await using _screen = await renderHost();
  const pane = useLayoutStore.getState().layout.workspaces[0]!.columns[1]!.panes[0]!;
  const first = pane.tabs.find((tab) => tab.id !== tabs.second.id)!;
  useLayoutStore.getState().focusTab(first.id);
  await vi.waitFor(() =>
    expect(joinOffset(secondPaneStrip())).toBe(tabOffset(secondPaneStrip(), first.id)),
  );
  const strip = secondPaneStrip();

  useLayoutStore.getState().focusTab(tabs.second.id);
  await vi.waitFor(() => expect(focusedTabId()).toBe(tabs.second.id));
  await vi.waitFor(() => expect(joinOffset(strip)).toBe(tabOffset(strip, tabs.second.id)));
  // The label under the landed shape reads as the active one, and only that one.
  await vi.waitFor(() =>
    expect(
      [...strip.querySelectorAll<HTMLElement>("[data-joined]")].map(
        (tab) => tab.dataset.layoutPaneTab,
      ),
    ).toEqual([tabs.second.id]),
  );
  expect(secondPaneStrip()).toBe(strip);
  expect(strip.isConnected).toBe(true);
});

it("keeps a pane's surface element across a switch among its tabs of one thread", () => {
  const shown = (tabId: string, paneId: string, threadKey = "thread-a") => ({
    tabId,
    paneId,
    threadKey,
  });
  const keys = (mounts: ReturnType<typeof selectSurfaceMounts>) =>
    Object.fromEntries([...mounts].map(([tabId, mount]) => [tabId, mount.key]));
  const first = selectSurfaceMounts(new Map(), [shown("files", "p1"), shown("diff", "p2")]);
  expect(keys(first)).toEqual({ files: "files", diff: "diff" });
  expect(selectSurfaceMounts(first, [shown("files", "p1"), shown("diff", "p2")])).toBe(first);

  // README.md replaces Files in its pane: the element stays, so its header does.
  const switched = selectSurfaceMounts(first, [shown("readme", "p1"), shown("diff", "p2")]);
  expect(keys(switched)).toEqual({ readme: "files", diff: "diff" });
  // Another thread's tab in that pane gets its own.
  const otherThread = selectSurfaceMounts(switched, [
    shown("pr", "p1", "thread-b"),
    shown("diff", "p2"),
  ]);
  expect(keys(otherThread)).toEqual({ pr: "pr", diff: "diff" });

  // A tab dragged to another pane takes its element along; the pane it left starts a new one,
  // never one just in use.
  const moved = selectSurfaceMounts(switched, [shown("readme", "p2"), shown("files", "p1")]);
  expect(keys(moved)).toEqual({ readme: "files", files: "files#2" });
});

it("keeps a surface's element, hidden, while another workspace shows", async () => {
  using _tabs = setup();
  const surfaceThread = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("files"));
  const panels = useRightPanelStore.getState();
  using _panels = { [Symbol.dispose]: () => useRightPanelStore.setState(panels) };
  useRightPanelStore.setState({
    byThreadKey: {
      [scopedThreadKey(surfaceThread)]: {
        isOpen: false,
        activeSurfaceId: "diff",
        surfaces: [{ id: "diff", kind: "diff" }],
      },
    },
  });
  useLayoutStore
    .getState()
    .openTab(
      { kind: "surface", threadRef: surfaceThread, surfaceId: "diff" },
      { placement: "new-column" },
    );
  const surfaceTabId = focusedTabId()!;
  await using _screen = await renderHost();
  const surface = () =>
    document.querySelector<HTMLElement>(`[data-layout-tab-id="${surfaceTabId}"]`);
  await vi.waitFor(() => expect(surface()?.hasAttribute("data-layout-pane-id")).toBe(true));
  const element = surface()!;

  await act(() => useLayoutStore.getState().focusWorkspaceStep(-1));
  await vi.waitFor(() => expect(element.hasAttribute("data-layout-pane-id")).toBe(false));
  expect(surface()).toBe(element);
  expect(getComputedStyle(element).contentVisibility).toBe("hidden");
  expect(element.getAttribute("aria-hidden")).toBe("true");

  await act(() => useLayoutStore.getState().focusWorkspaceStep(1));
  await vi.waitFor(() => expect(element.hasAttribute("data-layout-pane-id")).toBe(true));
  expect(surface()).toBe(element);
  expect(element.hasAttribute("aria-hidden")).toBe(false);
});

it("keeps an unfocused pane's joined tab with a dim rim, and black chrome keeps the notch", async () => {
  using _tabs = setup();
  await using _screen = await renderHost({ insetSidebar: true });
  const notch = inSecondPane('[data-pane-notch=""]');
  expect(notch.hasAttribute("data-pane-notch-unfocused")).toBe(true);
  // The bar runs the pane's whole width; the notch ends at its tabs.
  expect(getComputedStyle(notch, "::before").right).not.toBe("0px");
  const join = inSecondPane("[data-pane-join]");
  const position = join.style.getPropertyValue("--jx");
  const width = join.style.getPropertyValue("--jw");
  await vi.waitFor(() => {
    expect(getComputedStyle(join.querySelector("[data-jb]")!).opacity).toBe("1");
    expect(getComputedStyle(join.querySelector("[data-jr]")!).opacity).toBe("0.45");
    expect(getComputedStyle(join.querySelector("[data-jm]")!, "::after").opacity).toBe("0.45");
  });

  useLayoutStore
    .getState()
    .focusPane(notch.closest<HTMLElement>("[data-layout-pane-id]")!.dataset.layoutPaneId!);
  await vi.waitFor(() =>
    expect(getComputedStyle(join.querySelector("[data-jr]")!).opacity).toBe("1"),
  );
  expect(getComputedStyle(join.querySelector("[data-jb]")!).opacity).toBe("1");
  expect(join.style.getPropertyValue("--jx")).toBe(position);
  expect(join.style.getPropertyValue("--jw")).toBe(width);

  document.documentElement.classList.add("black-chrome");
  try {
    expect(getComputedStyle(join).display).toBe("none");
    expect(getComputedStyle(inSecondPane("[data-pane-bar-corner]")).display).toBe("none");
    expect(getComputedStyle(inSecondPane('[data-pane-notch=""]'), "::before").right).toBe("0px");
  } finally {
    document.documentElement.classList.remove("black-chrome");
  }
});

it("clears the pane's top corners so a joined tab's rim runs round them", async () => {
  using _tabs = setup();
  document.documentElement.style.setProperty("--desktop-window-corner-radius", "26px");
  try {
    await using _screen = await renderHost({ insetSidebar: true });
    const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!;
    const pane = inSecondPane("[data-pane-header]").closest<HTMLElement>("[data-layout-pane-id]")!;
    await vi.waitFor(() => {
      expect(pane.hasAttribute("data-pane-notched")).toBe(true);
      expect(inset.hasAttribute("data-pane-notched")).toBe(true);
    });
    expect(getComputedStyle(inset).borderStartStartRadius).toBe("0px");
    expect(getComputedStyle(inset).borderStartEndRadius).toBe("0px");
    expect(getComputedStyle(pane).borderStartStartRadius).toBe("0px");
    expect(getComputedStyle(pane).borderStartEndRadius).toBe("0px");
    expect(
      getComputedStyle(pane.querySelector(':scope > [data-pane-cut="start-top"]')!).display,
    ).toBe("none");
    expect(
      getComputedStyle(pane.querySelector(':scope > [data-pane-cut="end-top"]')!).display,
    ).toBe("none");
    expect(
      getComputedStyle(pane.querySelector(':scope > [data-pane-cut="start-bottom"]')!).display,
    ).toBe("flex");
  } finally {
    document.documentElement.style.removeProperty("--desktop-window-corner-radius");
  }
});

it("marks a hovered first tab's corner without reading layout on pointer moves", async () => {
  using _tabs = setup();
  await using _screen = await renderHost({ insetSidebar: true });
  const header = inSecondPane("[data-pane-header]");
  const pane = header.closest<HTMLElement>("[data-layout-pane-id]")!;
  const paneModel = useLayoutStore.getState().layout.workspaces[0]!.columns[1]!.panes[0]!;
  const [first, second] = paneModel.tabs;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  useLayoutStore.getState().focusPane(pane.dataset.layoutPaneId!);
  useLayoutStore.getState().focusTab(second!.id);
  const strip = secondPaneStrip();
  await vi.waitFor(() => {
    expect(
      strip.querySelector(`[data-layout-pane-tab="${second!.id}"]`)?.hasAttribute("data-joined"),
    ).toBe(true);
    expect(pane.querySelector("[data-pane-notch-unfocused]")).toBeNull();
  });

  const firstTab = strip.querySelector<HTMLElement>(`[data-layout-pane-tab="${first!.id}"]`)!;
  const secondTab = strip.querySelector<HTMLElement>(`[data-layout-pane-tab="${second!.id}"]`)!;
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  try {
    firstTab.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(header.hasAttribute("data-pane-hover-start")).toBe(true);
    expect(pane.hasAttribute("data-pane-hovered-start")).toBe(true);
    expect(rectSpy).not.toHaveBeenCalled();

    const setAttrSpy = vi.spyOn(Element.prototype, "setAttribute");
    const removeAttrSpy = vi.spyOn(Element.prototype, "removeAttribute");
    try {
      (firstTab.firstElementChild ?? firstTab).dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true }),
      );
      expect(setAttrSpy).not.toHaveBeenCalled();
      expect(removeAttrSpy).not.toHaveBeenCalled();
    } finally {
      setAttrSpy.mockRestore();
      removeAttrSpy.mockRestore();
    }

    secondTab.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(header.hasAttribute("data-pane-hover-start")).toBe(false);
    expect(pane.hasAttribute("data-pane-hovered-start")).toBe(false);
    expect(rectSpy).not.toHaveBeenCalled();
  } finally {
    rectSpy.mockRestore();
  }
});

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("chat"));
const pullRequestThreadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("pr"));
const sideChatRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("side"));

function SurfaceSync() {
  useLayoutSurfaceSync();
  return null;
}

function setupPullRequestDrop() {
  const stack = new DisposableStack();
  const layout = useLayoutStore.getState().layout;
  const panels = useRightPanelStore.getState();
  stack.defer(() => useLayoutStore.setState({ layout }));
  stack.defer(() => useRightPanelStore.setState(panels));
  useLayoutStore.setState({ layout: createLayoutState() });
  useRightPanelStore.setState({ byThreadKey: {} });
  useLayoutStore.getState().openTab({ kind: "chat", target: { kind: "server", threadRef } });
  const chatPaneId = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.pane.id;
  return { chatPaneId, [Symbol.dispose]: () => stack.dispose() };
}

it.each<{ name: string; surface: LayoutDragSurface; hosted?: boolean }>([
  {
    name: "pull request",
    surface: pullRequestSurface({
      projectId: "project",
      repository: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
    }),
  },
  { name: "side chat's file", surface: fileSurface("src/app.ts", 12, 0), hosted: true },
])(
  "opens a thread's $name beside a chat of another thread, and it survives a reload",
  async ({ surface, hosted }) => {
    using fixture = setupPullRequestDrop();
    const { chatPaneId } = fixture;
    using _host = hosted
      ? { [Symbol.dispose]: hostRightPanel(sideChatRef, pullRequestThreadRef) }
      : undefined;
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: hosted ? sideChatRef : pullRequestThreadRef,
      surface,
    };
    const surfaceTab = () =>
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
        ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === source.surface.id,
      );
    await using screen = await render(<SurfaceSync />);

    await act(() => {
      expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "down" })).toBe(
        true,
      );
    });
    const chatColumn = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.column;
    expect(surfaceTab()!.column.id).toBe(chatColumn.id);
    expect(chatColumn.panes.map((pane) => pane.id)).toEqual([chatPaneId, surfaceTab()!.pane.id]);
    expect(findLayoutChatForThread(useLayoutStore.getState().layout, pullRequestThreadRef)).toBe(
      null,
    );
    expect(
      isLayoutDropUseful(useLayoutStore.getState().layout, source, {
        kind: "side",
        paneId: surfaceTab()!.pane.id,
        side: "left",
      }),
    ).toBe(false);

    await screen.unmount();
    await using _reloaded = await render(<SurfaceSync />);
    expect(surfaceTab()?.pane.id).toBeDefined();

    await act(() => {
      expect(commitLayoutDrop(source, { kind: "into", paneId: chatPaneId })).toBe(true);
    });
    expect(surfaceTab()!.pane.id).toBe(chatPaneId);
    expect(
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef),
    ).toHaveLength(1);
  },
);

it.each<{ name: string; surface: LayoutDragSurface; hosted?: boolean }>([
  {
    name: "pull request",
    surface: pullRequestSurface({
      projectId: "project",
      repository: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
    }),
  },
  { name: "file", surface: fileSurface("src/app.ts", 12, 0) },
  { name: "file of a side chat", surface: fileSurface("src/app.ts", 12, 0), hosted: true },
])(
  "drops only the dragged $name where it lands when the thread's panel hides other surfaces",
  async ({ surface, hosted }) => {
    using fixture = setupPullRequestDrop();
    using _host = hosted
      ? { [Symbol.dispose]: hostRightPanel(sideChatRef, pullRequestThreadRef) }
      : undefined;
    const { chatPaneId } = fixture;
    useRightPanelStore.setState({
      byThreadKey: {
        [scopedThreadKey(pullRequestThreadRef)]: {
          isOpen: false,
          activeSurfaceId: "diff",
          surfaces: [{ id: "diff", kind: "diff" }],
        },
      },
    });
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: hosted ? sideChatRef : pullRequestThreadRef,
      surface,
    };
    const tabFor = (surfaceId: string) =>
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
        ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === surfaceId,
      );
    await using _screen = await render(<SurfaceSync />);

    await act(() => {
      expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "down" })).toBe(
        true,
      );
    });
    const dropped = tabFor(surface.id)!;
    const chatColumn = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.column;
    expect(chatColumn.panes.map((pane) => pane.id)).toEqual([chatPaneId, dropped.pane.id]);
    expect(dropped.pane.tabs.map((tab) => tab.id)).toEqual([dropped.tab.id]);
    expect(tabFor("diff")?.pane.id).toBe(chatPaneId);
  },
);

it.each(["left", "right"] as const)(
  "moves a file tab open in another workspace to the focused workspace's %s edge",
  async (edge) => {
    using _fixture = setupPullRequestDrop();
    const column = (id: string, tabs: LayoutTab[]): LayoutColumn => ({
      id,
      width: 1,
      panes: [{ id: `${id}-pane`, tabs, activeTabId: tabs[0]!.id, size: 1 }],
    });
    const workspace = (id: string, columns: LayoutColumn[]) => ({
      id,
      name: null,
      focusedPaneId: columns[0]!.panes[0]!.id,
      cameraWidth: null,
      columns,
    });
    const fileTab = createLayoutTab({
      kind: "surface",
      threadRef: pullRequestThreadRef,
      surfaceId: "file:src/app.ts",
    });
    useLayoutStore.setState({
      layout: {
        focusedWorkspaceId: "focused",
        workspaces: [
          workspace("focused", [
            column("chat", [
              createLayoutTab({ kind: "chat", target: { kind: "server", threadRef } }),
            ]),
          ]),
          workspace("other", [
            column("file", [fileTab]),
            column("other-chat", [
              createLayoutTab({
                kind: "chat",
                target: { kind: "server", threadRef: pullRequestThreadRef },
              }),
            ]),
          ]),
        ],
      },
    });
    useRightPanelStore.setState({
      byThreadKey: {
        [scopedThreadKey(pullRequestThreadRef)]: {
          isOpen: true,
          activeSurfaceId: "file:src/app.ts",
          surfaces: [fileSurface("src/app.ts", 12, 1)],
        },
      },
    });
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: pullRequestThreadRef,
      surface: fileSurface("src/app.ts", 30, 0),
    };
    await using _screen = await render(<SurfaceSync />);

    await act(() => {
      expect(commitLayoutDrop(source, { kind: "extend", edge })).toBe(true);
    });
    const moved = findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef);
    expect(moved.map(({ tab }) => tab.id)).toEqual([fileTab.id]);
    expect(moved[0]!.workspace.id).toBe("focused");
    const edgeColumn =
      edge === "left" ? moved[0]!.workspace.columns[0] : moved[0]!.workspace.columns.at(-1);
    expect(edgeColumn!.panes.map((pane) => pane.tabs.map((tab) => tab.id))).toEqual([[fileTab.id]]);
  },
);

it.each([
  { where: "beside", opened: "a new" },
  { where: "into", opened: "a new" },
  { where: "beside", opened: "an already open" },
  { where: "into", opened: "an already open" },
] as const)(
  "drops a $opened file $where a standalone Files pane where the Files pane was",
  async ({ where, opened }) => {
    using fixture = setupPullRequestDrop();
    const { chatPaneId } = fixture;
    const tabFor = (surfaceId: string) =>
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
        ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === surfaceId,
      );
    await using _screen = await render(<SurfaceSync />);
    await act(() => {
      if (opened === "an already open") {
        useRightPanelStore.getState().openFile(pullRequestThreadRef, "src/app.ts", 12);
      }
      requestLayoutSurfacePlacement(pullRequestThreadRef, {
        kind: "split",
        paneId: chatPaneId,
        side: "right",
      });
      useRightPanelStore.getState().open(pullRequestThreadRef, "files");
    });
    const files = tabFor("files")!;
    expect(files.pane.id).not.toBe(chatPaneId);
    if (opened === "an already open") expect(tabFor("file:src/app.ts")!.pane.id).toBe(chatPaneId);
    const source: LayoutDragSource = {
      kind: "surface",
      threadRef: pullRequestThreadRef,
      surface: fileSurface("src/app.ts", 12, 0),
    };

    await act(() => {
      expect(
        commitLayoutDrop(
          source,
          where === "into"
            ? { kind: "into", paneId: files.pane.id }
            : { kind: "side", paneId: files.pane.id, side: "down" },
        ),
      ).toBe(true);
    });
    const file = tabFor("file:src/app.ts")!;
    expect(tabFor("files")).toBeUndefined();
    expect(
      findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef),
    ).toHaveLength(1);
    expect(file.column.id).toBe(files.column.id);
    expect(file.pane.tabs.map((tab) => tab.id)).toEqual([file.tab.id]);
    if (where === "into") expect(file.pane.id).toBe(files.pane.id);
  },
);

it("keeps a Files split pane intact when opening the first file from it", async () => {
  using fixture = setupPullRequestDrop();
  const { chatPaneId } = fixture;
  const tabFor = (surfaceId: string) =>
    findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
      ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === surfaceId,
    );
  await using _screen = await render(<SurfaceSync />);
  await act(() => {
    requestLayoutSurfacePlacement(pullRequestThreadRef, {
      kind: "split",
      paneId: chatPaneId,
      side: "right",
    });
    useRightPanelStore.getState().open(pullRequestThreadRef, "files");
  });
  const files = tabFor("files")!;
  expect(files.pane.id).not.toBe(chatPaneId);

  await act(() => {
    useRightPanelStore.getState().openFile(pullRequestThreadRef, "src/app.ts");
  });
  const file = tabFor("file:src/app.ts")!;
  expect(tabFor("files")).toBeUndefined();
  expect(file.pane.id).toBe(files.pane.id);
  expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(file.tab.id);
});

it("opening a second file in a reused surface pane does not loop through rightPanelStore.syncFromLayout", async () => {
  using fixture = setupPullRequestDrop();
  const { chatPaneId } = fixture;
  const tabFor = (surfaceId: string) =>
    findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
      ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === surfaceId,
    );
  await using screen = await renderHost();
  await act(() => {
    requestLayoutSurfacePlacement(pullRequestThreadRef, {
      kind: "pane",
      paneId: chatPaneId,
    });
    useRightPanelStore.getState().openFile(pullRequestThreadRef, "src/first.ts");
  });
  const firstTab = tabFor("file:src/first.ts")!;
  const host = screen.container.querySelector<HTMLElement>(
    `[data-layout-tab-id="${firstTab.tab.id}"]`,
  )!;
  const inner = document.createElement("button");
  inner.dataset.workspaceArea = "panel";
  inner.textContent = "tree item";
  host.prepend(inner);
  inner.focus();
  expect(document.activeElement).toBe(inner);
  expect(inner.getBoundingClientRect().height).toBeGreaterThan(0);

  const focusSequence: Array<string | undefined> = [];
  const unsub = useLayoutStore.subscribe((state) => {
    focusSequence.push(selectFocusedTab(state.layout)?.id);
  });
  try {
    await act(() => {
      useRightPanelStore.getState().openFile(pullRequestThreadRef, "src/second.ts");
    });
    expect(document.activeElement).toBe(inner);
    await act(() => {
      useRightPanelStore.getState().openFile(pullRequestThreadRef, "src/third.ts");
    });

    const secondTab = tabFor("file:src/second.ts")!;
    const thirdTab = tabFor("file:src/third.ts")!;
    expect(focusSequence).toEqual([secondTab.tab.id, thirdTab.tab.id]);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(thirdTab.tab.id);
    expect(
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(pullRequestThreadRef)]
        ?.activeSurfaceId,
    ).toBe("file:src/third.ts");
  } finally {
    unsub();
  }
});

it("hides a thread's companion splits when switching tabs in the same pane and restores them on return", async () => {
  using fixture = setupPullRequestDrop();
  const { chatPaneId } = fixture;
  const terminalBefore = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
  using _restoreTerminals = {
    [Symbol.dispose]: () =>
      useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: terminalBefore }),
  };
  useTerminalUiStateStore.setState({ terminalUiStateByThreadKey: {} });
  useLayoutStore.getState().openKeptTab({
    kind: "chat",
    target: { kind: "server", threadRef: pullRequestThreadRef },
  });
  const threadATab = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!;
  const threadBTab = findLayoutChatForThread(
    useLayoutStore.getState().layout,
    pullRequestThreadRef,
  )!;
  useLayoutStore.getState().focusTab(threadATab.tab.id);
  await using _screen = await render(<SurfaceSync />);

  await act(() => {
    requestLayoutSurfacePlacement(threadRef, { kind: "split", paneId: chatPaneId, side: "right" });
    useRightPanelStore.getState().open(threadRef, "diff");
    requestLayoutSurfacePlacement(threadRef, { kind: "split", paneId: chatPaneId, side: "down" });
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    useLayoutStore.getState().focusTab(threadATab.tab.id);
  });
  expect(findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef)).toHaveLength(2);

  await act(() => {
    focusAdjacentLayoutTab(1);
  });
  expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(threadBTab.tab.id);
  expect(findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef)).toHaveLength(0);
  expect(useLayoutStore.getState().hiddenCompanionsByThreadKey[scopedThreadKey(threadRef)]).toEqual(
    { panel: true, terminal: true },
  );
  expect(
    useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.map((s) => s.id),
  ).toEqual(["diff"]);

  await act(() => {
    focusAdjacentLayoutTab(-1);
  });
  expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(threadATab.tab.id);
  expect(findLayoutSurfaceTabs(useLayoutStore.getState().layout, threadRef)).toHaveLength(2);
  expect(
    useLayoutStore.getState().hiddenCompanionsByThreadKey[scopedThreadKey(threadRef)],
  ).toBeUndefined();
});

it("does not switch tabs when releasing the pointer after Escape cancels a tab drag", async () => {
  using tabs = setup();
  await using _screen = await renderHost();
  const pane = useLayoutStore.getState().layout.workspaces[0]!.columns[1]!.panes[0]!;
  const first = pane.tabs.find((tab) => tab.id !== tabs.second.id)!;
  useLayoutStore.getState().focusTab(first.id);
  await vi.waitFor(() =>
    expect(secondPaneStrip().querySelector<HTMLElement>("[data-joined]")?.dataset.layoutPaneTab).toBe(
      first.id,
    ),
  );

  const strip = secondPaneStrip();
  const inactiveTab = strip.querySelector<HTMLElement>(`[data-layout-pane-tab="${tabs.second.id}"]`)!;
  const rect = inactiveTab.getBoundingClientRect();
  inactiveTab.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 1,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerId: 1,
      clientX: rect.left + 32,
      clientY: rect.top + 8,
    }),
  );
  expect(isLayoutDragActive()).toBe(true);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(isLayoutDragActive()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  window.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 1,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }),
  );
  inactiveTab.click();
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(focusedTabId()).toBe(first.id);
});

it("keeps the tab drag insertion marker inside an overflowing tab strip", async () => {
  using _tabs = setup();
  for (let index = 0; index < 12; index++) {
    useLayoutStore
      .getState()
      .openTab(createLayoutLauncherContent(null), { placement: "active-pane" });
  }
  await using screen = await render(
    <>
      <Host />
      <LayoutDropZones />
    </>,
  );
  await page.viewport(900, 600);
  const pane = screen.container.querySelector<HTMLElement>("[data-layout-pane-id]")!;
  const strip = pane.querySelector<HTMLElement>("[data-layout-tab-strip]")!;
  await vi.waitFor(() => expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth));
  const firstTab = strip.querySelector<HTMLElement>("[data-layout-pane-tab]")!;
  const paneRect = pane.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const startRect = firstTab.getBoundingClientRect();
  try {
    firstTab.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: startRect.left + 8,
        clientY: startRect.top + 8,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: paneRect.right - 12,
        clientY: stripRect.top + 8,
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-layout-drag-overlay] .w-0\\.5")).not.toBeNull(),
    );
    const marker = document
      .querySelector<HTMLElement>("[data-layout-drag-overlay] .w-0\\.5")!
      .getBoundingClientRect();
    expect(marker.left).toBeGreaterThanOrEqual(Math.max(paneRect.left, stripRect.left) - 1);
    expect(marker.right).toBeLessThanOrEqual(Math.min(paneRect.right, stripRect.right) + 1);
  } finally {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  }
});
