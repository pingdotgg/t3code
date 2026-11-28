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

it("isolates a failing page pane without unmounting sibling panes", async () => {
  pageMock.failIssues = true;
  using _restoreError = vi.spyOn(console, "error").mockImplementation(() => {});
  using _resetFlag = {
    [Symbol.dispose]: () => {
      pageMock.failIssues = false;
    },
  };
  await using _screen = await render(
    <div>
      <div>Sibling chat pane</div>
      <LayoutPageBody content={{ kind: "issues" }} />
    </div>,
  );

  await expect.element(page.getByText("Couldn’t load this page.")).toBeVisible();
  await expect.element(page.getByText("Sibling chat pane")).toBeVisible();

  pageMock.failIssues = false;
  await userEvent.click(page.getByRole("button", { name: "Retry" }));
  await expect.element(page.getByText("Issues ready")).toBeVisible();
});
