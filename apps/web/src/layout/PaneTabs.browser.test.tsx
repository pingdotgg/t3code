import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ContextMenuItem } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  show: vi.fn<(items: ReadonlyArray<ContextMenuItem<string>>) => Promise<string | null>>(),
}));

const threadShell = {
  id: "thread",
  environmentId: "local",
  projectId: "project",
  title: "Inactive thread",
  branch: "main",
  worktreePath: null,
  runtime: null,
  latestRun: null,
};

vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ contextMenu: { show: state.show, close: () => {} } })) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => threadShell) as never,
  useQuietThreadShell: ((ref: unknown) => (ref ? threadShell : null)) as never,
  readEnvironmentServerConfigLoaded: () => true,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { useRightPanelStore } from "../rightPanelStore";
import { createLayoutState, findLayoutTab, type LayoutTabContent } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { LayoutPaneTab } from "./PaneTabs";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread"));
const thread: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef } };
const otherBrowser: LayoutTabContent = { kind: "surface", threadRef, surfaceId: "browser:tab_2" };
const activeBrowser: LayoutTabContent = { kind: "surface", threadRef, surfaceId: "browser:tab_1" };

function setup() {
  state.show.mockReset().mockResolvedValue(null);
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.getState().openBrowser(threadRef, "tab_2");
  useRightPanelStore.getState().openBrowser(threadRef, "tab_1");
  useLayoutStore.setState({ layout: createLayoutState() });
  for (const content of [thread, otherBrowser, activeBrowser]) {
    useLayoutStore.getState().openTab(content, { placement: "active-pane", position: "end" });
  }
  const tabOf = (content: LayoutTabContent) =>
    findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === content)!.tab;
  return { tabOf };
}

const shownLabels = () => state.show.mock.calls.at(-1)?.[0].map((item) => item.label);

it("an inactive tab beside an active browser opens its own menu without being shown", async () => {
  const { tabOf } = setup();
  const activeTabId = tabOf(activeBrowser).id;
  await using _screen = await render(
    <>
      <LayoutPaneTab tab={tabOf(thread)} />
      <LayoutPaneTab tab={tabOf(otherBrowser)} />
    </>,
  );

  await page.getByRole("button", { name: "Inactive thread" }).click({ button: "right" });
  await vi.waitFor(() => expect(state.show).toHaveBeenCalledTimes(1));
  expect(shownLabels()).toEqual(
    expect.arrayContaining(["Copy link", "Rename thread", "Archive thread"]),
  );

  const browserTab = document.querySelector(`[data-layout-pane-tab="${tabOf(otherBrowser).id}"]`);
  await page.elementLocator(browserTab!).click({ button: "right" });
  await vi.waitFor(() => expect(state.show).toHaveBeenCalledTimes(2));
  expect(shownLabels()?.[0]).toBe("Mute tab");
  expect(shownLabels()).toContain("Close others");

  expect(findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === activeTabId)).toEqual(
    expect.objectContaining({ pane: expect.objectContaining({ activeTabId }) }),
  );
});
