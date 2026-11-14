import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useLayoutBehaviorStore } from "./layoutBehavior";
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
  const geometry = () => ({
    scrollLeft: strip.scrollLeft,
    viewportWidth: strip.clientWidth,
    scrollWidth: strip.scrollWidth,
    tabLeft: element.getBoundingClientRect().left,
    focusedTabId: focusedTabId(),
    behavior: useLayoutBehaviorStore.getState().behavior.whenNoRoom,
    workspace: useLayoutStore.getState().layout.workspaces[0],
  });
  const beforePress = geometry();
  const pointer = { bubbles: true, button: 0, pointerType: "mouse" } as const;
  element.dispatchEvent(new PointerEvent("pointerdown", pointer));
  await expect
    .element(page.elementLocator(element.closest("[data-layout-pane-id]")!))
    .toHaveAttribute("data-layout-pane-focused", "true");
  expect(strip.scrollLeft).toBe(held);
  element.dispatchEvent(new PointerEvent("pointerup", pointer));
  const afterRelease = geometry();
  await page.elementLocator(element).click();
  await vi.waitFor(() =>
    expect(
      strip.scrollLeft,
      JSON.stringify({ beforePress, afterRelease, afterClick: geometry() }),
    ).toBeGreaterThan(held),
  );
}

it("shows a tab in an unfocused pane that runs off screen with one click on it", async () => {
  using tabs = setup();
  await using _screen = await renderHost();
  await clickHeld(inSecondPane(`[data-layout-pane-tab="${tabs.second.id}"]`));
  await vi.waitFor(() => expect(focusedTabId()).toBe(tabs.second.id));
});

const secondPaneStrip = () => inSecondPane("[data-layout-tab-strip]");
const joinOffset = (strip: HTMLElement) =>
  Number.parseFloat(
    strip.querySelector<HTMLElement>("[data-pane-join]")!.style.getPropertyValue("--jx"),
  );
const tabOffset = (strip: HTMLElement, tabId: string) => {
  const tab = strip.querySelector<HTMLElement>(`[data-layout-pane-tab="${tabId}"]`)!;
  const left = tab.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  return left + strip.scrollLeft;
};

it("keeps a pane's tab strip and moves its joined tab when the pane switches tabs", async () => {
  using tabs = setup();
  await using _screen = await renderHost();
  const pane = useLayoutStore.getState().layout.workspaces[0]!.columns[1]!.panes[0]!;
  const first = pane.tabs.find((tab) => tab.id !== tabs.second.id)!;
  useLayoutStore.getState().focusTab(first.id);
  // Chromium rounds layout pixels separately from transformed bounding boxes.
  await vi.waitFor(() =>
    expect(
      Math.abs(joinOffset(secondPaneStrip()) - tabOffset(secondPaneStrip(), first.id)),
    ).toBeLessThanOrEqual(1),
  );
  const strip = secondPaneStrip();

  useLayoutStore.getState().focusTab(tabs.second.id);
  await vi.waitFor(() => expect(focusedTabId()).toBe(tabs.second.id));
  await vi.waitFor(() =>
    expect(Math.abs(joinOffset(strip) - tabOffset(strip, tabs.second.id))).toBeLessThanOrEqual(1),
  );
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

it("shows an unfocused pane's active tab as a pill, and black chrome keeps the notch", async () => {
  using tabs = setup();
  await using _screen = await renderHost({ insetSidebar: true });
  const notch = inSecondPane('[data-pane-notch=""]');
  expect(notch.hasAttribute("data-pane-notch-unfocused")).toBe(true);
  // The bar runs the pane's whole width; the notch ends at its tabs.
  expect(getComputedStyle(notch, "::before").right).not.toBe("0px");
  const join = inSecondPane("[data-pane-join]");
  // Focus moving between panes cross-fades the joined tab and the pill.
  await vi.waitFor(() => {
    expect(getComputedStyle(join.querySelector("[data-jp]")!).opacity).toBe("1");
    expect(getComputedStyle(join.querySelector("[data-jb]")!).opacity).toBe("0");
  });

  useLayoutStore.getState().focusTab(tabs.second.id);
  await vi.waitFor(() =>
    expect(getComputedStyle(join.querySelector("[data-jb]")!).opacity).toBe("1"),
  );

  document.documentElement.classList.add("black-chrome");
  try {
    expect(getComputedStyle(join).display).toBe("none");
    expect(getComputedStyle(inSecondPane("[data-pane-bar-corner]")).display).toBe("none");
    expect(getComputedStyle(inSecondPane('[data-pane-notch=""]'), "::before").right).toBe("0px");
  } finally {
    document.documentElement.classList.remove("black-chrome");
  }
});
