import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const pageMock = vi.hoisted(() => ({ failIssues: false }));
vi.mock(import("../components/issue/IssuesPage"), () => ({
  IssuesPage: () => {
    if (pageMock.failIssues) throw new Error("chunk load failed");
    return <div>Issues ready</div>;
  },
}));

import { render } from "../../test/render";
import { createLayoutLauncherContent, findLayoutTab } from "./layoutModel";
import { LayoutPaneContext } from "./layoutPaneContext";
import { useLayoutStore } from "./layoutStore";
import { useOpenLayoutPage } from "./pageNavigation";
import { LayoutPageBody } from "./PageSurface";

function OpenSettingsFrom({ tabId }: { tabId: string }) {
  const openLayoutPage = useOpenLayoutPage();
  return (
    <button type="button" onClick={() => void openLayoutPage("settings", undefined, tabId)}>
      Settings
    </button>
  );
}

it("opening Settings from a launcher tab does not leave the empty tab behind", async () => {
  const store = useLayoutStore.getState();
  store.reset();
  store.openTab({ kind: "pull-requests" });
  const launcher = createLayoutLauncherContent(null);
  store.openTab(launcher);
  const launcherTabId = findLayoutTab(
    useLayoutStore.getState().layout,
    (tab) => tab.content === launcher,
  )?.tab.id;
  expect(launcherTabId).toBeDefined();

  await using _screen = await render(<OpenSettingsFrom tabId={launcherTabId ?? ""} />);
  await userEvent.click(page.getByRole("button", { name: "Settings" }));

  await expect
    .poll(() => findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === launcher))
    .toBeNull();
});

it("isolates a failing page pane and keeps its tab strip", async () => {
  pageMock.failIssues = true;
  using _restoreError = vi.spyOn(console, "error").mockImplementation(() => {});
  using _resetFlag = {
    [Symbol.dispose]: () => {
      pageMock.failIssues = false;
    },
  };
  const store = useLayoutStore.getState();
  store.reset();
  store.openTab({ kind: "pull-requests" });
  store.openTab({ kind: "issues" });
  const issues = findLayoutTab(
    useLayoutStore.getState().layout,
    (tab) => tab.content.kind === "issues",
  );
  expect(issues?.pane.tabs.map((tab) => tab.content.kind)).toEqual(["pull-requests", "issues"]);
  await using _screen = await render(
    <div>
      <div>Sibling chat pane</div>
      <LayoutPaneContext
        value={{
          tabId: issues?.tab.id ?? null,
          paneId: issues?.pane.id ?? null,
          split: true,
          narrow: false,
          leadingEdge: false,
          trailingEdge: false,
          focused: true,
          related: false,
          visible: true,
        }}
      >
        <LayoutPageBody content={{ kind: "issues" }} />
      </LayoutPaneContext>
    </div>,
  );

  await expect.element(page.getByText("Could not load this page")).toBeVisible();
  await expect.element(page.getByText("Sibling chat pane")).toBeVisible();
  await expect.element(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  await expect.element(page.getByText("Pull requests")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "New tab" })).toBeVisible();

  pageMock.failIssues = false;
  await userEvent.click(page.getByRole("button", { name: "Retry" }));
  await expect.element(page.getByText("Issues ready")).toBeVisible();
});
