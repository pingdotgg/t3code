import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { createLayoutLauncherContent, createLayoutState, selectFocusedTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutPaneTab } from "./PaneTabs";

function setup() {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  for (let index = 0; index < 7; index++) {
    useLayoutStore.getState().openTab(createLayoutLauncherContent(null));
  }
  const tabs = useLayoutStore.getState().layout.workspaces[0]!.columns[0]!.panes[0]!.tabs;
  return {
    tabs,
    [Symbol.dispose]: () => useLayoutStore.setState({ layout: original }),
  };
}

it("selects a squeezed tab clicked in its middle instead of closing it", async () => {
  using layout = setup();
  await using screen = await render(
    <div className="flex w-60 gap-1 overflow-hidden">
      {layout.tabs.map((tab) => (
        <LayoutPaneTab key={tab.id} tab={tab} />
      ))}
    </div>,
  );
  const target = layout.tabs[2]!;
  const slot = screen.container.querySelector(
    `[data-layout-pane-tab="${target.id}"]`,
  )!.parentElement!;
  expect(slot.getBoundingClientRect().width).toBeLessThan(40);

  await userEvent.click(slot);

  const state = useLayoutStore.getState().layout;
  expect(state.workspaces[0]!.columns[0]!.panes[0]!.tabs).toHaveLength(7);
  expect(selectFocusedTab(state)?.id).toBe(target.id);
});
