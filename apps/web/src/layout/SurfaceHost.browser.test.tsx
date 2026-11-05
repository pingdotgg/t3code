import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import {
  createLayoutLauncherContent,
  createLayoutState,
  selectFocusedTab,
  selectVisibleLayoutTabs,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutSurfaceHost } from "./SurfaceHost";

const TOUR_KEY = "t3code:layout-tour:v1";

function setup() {
  const original = useLayoutStore.getState().layout;
  const tour = localStorage.getItem(TOUR_KEY);
  localStorage.setItem(TOUR_KEY, "true");
  useLayoutStore.setState({ layout: createLayoutState() });
  const store = useLayoutStore.getState();
  store.openTab(createLayoutLauncherContent(null), { placement: "active-pane" });
  store.openTab(createLayoutLauncherContent(null), { placement: "new-column" });
  const layout = useLayoutStore.getState().layout;
  const workspace = layout.workspaces[0]!;
  const columns = workspace.columns.map((column) => ({ ...column, width: 2 / 3 }));
  const [first, second] = columns.map((column) => column.panes[0]!.tabs[0]!);
  useLayoutStore.setState({
    layout: {
      ...layout,
      workspaces: [{ ...workspace, columns, focusedPaneId: columns[0]!.panes[0]!.id }],
    },
  });
  return {
    first: first!,
    second: second!,
    [Symbol.dispose]: () => {
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

it("closes a tab in an unfocused pane that runs off screen with one click on its close button", async () => {
  await page.viewport(900, 600);
  using tabs = setup();
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:0;display:flex;";
  await using screen = await render(<Host />, { container });
  const close = screen.getByRole("button", { name: "Close New tab" }).nth(1);
  close
    .element()
    .dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
  expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(tabs.first.id);
  await close.click();
  await vi.waitFor(() =>
    expect(selectVisibleLayoutTabs(useLayoutStore.getState().layout).map((tab) => tab.id)).toEqual([
      tabs.first.id,
    ]),
  );
  expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(tabs.first.id);
});
