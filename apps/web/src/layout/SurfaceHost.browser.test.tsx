import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, render } from "../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { pullRequestSurface, useRightPanelStore } from "../rightPanelStore";
import { useLayoutBehaviorStore } from "./layoutBehavior";
import { commitLayoutDrop, isLayoutDropUseful, type LayoutDragSource } from "./layoutDrag";
import {
  createLayoutLauncherContent,
  createLayoutState,
  findLayoutChatForThread,
  findLayoutSurfaceTabs,
  selectFocusedTab,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutSurfaceHost } from "./SurfaceHost";
import { useLayoutSurfaceSync } from "./surfaceSync";

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

async function renderHost({ insetSidebar = false } = {}) {
  await page.viewport(900, 600);
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;display:flex;";
  // The pane chrome (index.css) styles an inset that follows the app's inset sidebar.
  const sidebar = insetSidebar ? <div data-slot="sidebar" data-variant="inset" hidden /> : null;
  return render(
    <>
      {sidebar}
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

const secondPaneStrip = () => inSecondPane("[data-layout-tab-strip]");
const joinOffset = (strip: HTMLElement) =>
  strip.querySelector<HTMLElement>("[data-pane-join]")!.style.getPropertyValue("--jx");
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
  strip.scrollLeft = 100;
  const before = workspace.scrollLeft;

  await userEvent.wheel(header.querySelector('button[aria-label="New tab"]')!, {
    delta: { x: 40 },
  });

  await vi.waitFor(() => expect(strip.scrollLeft).toBe(140));
  expect(workspace.scrollLeft).toBe(before);
  const active = strip.querySelector<HTMLElement>("[data-joined]")!;
  expect(joinOffset(strip)).toBe(tabOffset(strip, active.dataset.layoutPaneTab!));

  await userEvent.wheel(header.querySelector('button[aria-label="New tab"]')!, {
    delta: { x: -140 },
  });
  await vi.waitFor(() => expect(strip.scrollLeft).toBe(0));
  const tabs = [...strip.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")];
  for (const tab of tabs) {
    if (tab !== active) useLayoutStore.getState().closeTab(tab.dataset.layoutPaneTab!);
  }
  await vi.waitFor(() => expect(strip.scrollWidth).toBe(strip.clientWidth));
  await vi.waitFor(() =>
    expect(strip.closest("[data-pane-header]")?.hasAttribute("data-tab-row-overflow")).toBe(false),
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

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("chat"));
const pullRequestThreadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("pr"));

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

it("opens a thread's pull request beside a chat of another thread, and it survives a reload", async () => {
  using fixture = setupPullRequestDrop();
  const { chatPaneId } = fixture;
  const source: LayoutDragSource = {
    kind: "surface",
    threadRef: pullRequestThreadRef,
    surface: pullRequestSurface({
      projectId: "project",
      repository: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
    }),
  };
  const surfaceTab = () =>
    findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
      ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === source.surface.id,
    );
  await using screen = await render(<SurfaceSync />);

  await act(() => {
    expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "down" })).toBe(true);
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
});

it("drops only the dragged pull request where it lands when the thread's panel hides other surfaces", async () => {
  using fixture = setupPullRequestDrop();
  const { chatPaneId } = fixture;
  useRightPanelStore.setState({
    byThreadKey: {
      [scopedThreadKey(pullRequestThreadRef)]: {
        isOpen: false,
        activeSurfaceId: "files",
        surfaces: [{ id: "files", kind: "files" }],
      },
    },
  });
  const surface = pullRequestSurface({
    projectId: "project",
    repository: "owner/repo",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
  });
  const source: LayoutDragSource = { kind: "surface", threadRef: pullRequestThreadRef, surface };
  const tabFor = (surfaceId: string) =>
    findLayoutSurfaceTabs(useLayoutStore.getState().layout, pullRequestThreadRef).find(
      ({ tab }) => tab.content.kind === "surface" && tab.content.surfaceId === surfaceId,
    );
  await using _screen = await render(<SurfaceSync />);

  await act(() => {
    expect(commitLayoutDrop(source, { kind: "side", paneId: chatPaneId, side: "down" })).toBe(true);
  });
  const dropped = tabFor(surface.id)!;
  const chatColumn = findLayoutChatForThread(useLayoutStore.getState().layout, threadRef)!.column;
  expect(chatColumn.panes.map((pane) => pane.id)).toEqual([chatPaneId, dropped.pane.id]);
  expect(dropped.pane.tabs.map((tab) => tab.id)).toEqual([dropped.tab.id]);
  expect(tabFor("files")?.pane.id).toBe(chatPaneId);
});
