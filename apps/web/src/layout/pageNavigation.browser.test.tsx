import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { createLayoutLauncherContent, findLayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { useOpenLayoutPage } from "./pageNavigation";

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
  expect(
    findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content.kind === "pull-requests"),
  ).not.toBeNull();
});
