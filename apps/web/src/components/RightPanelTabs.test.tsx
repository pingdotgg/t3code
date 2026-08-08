import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { RightPanelTabs } from "./RightPanelTabs";

vi.mock("~/env", () => ({ isElectron: true }));

/** The opening tag carrying `attribute`, so class assertions pin the element, not attribute order. */
function tagWith(markup: string, attribute: string): string {
  const index = markup.indexOf(attribute);
  if (index === -1) throw new Error(`no element carries ${attribute}`);
  return markup.slice(markup.lastIndexOf("<", index), markup.indexOf(">", index) + 1);
}

describe("RightPanelTabs", () => {
  it("keeps the Electron titlebar draggable without swallowing tab strip scrolling", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs
        mode="inline"
        surfaces={[]}
        activeSurfaceId={null}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        terminalLabelsById={new Map()}
        onActivate={vi.fn()}
        onCloseSurface={vi.fn()}
        onCloseOtherSurfaces={vi.fn()}
        onCloseSurfacesToRight={vi.fn()}
        onCloseAllSurfaces={vi.fn()}
        onCopyFilePath={vi.fn()}
        onAddBrowser={vi.fn()}
        onAddTerminal={vi.fn()}
        onAddDiff={vi.fn()}
        onAddFiles={vi.fn()}
        onAddAgents={vi.fn()}
        browserAvailable
        diffAvailable
        filesAvailable
      >
        <div />
      </RightPanelTabs>,
    );

    expect(tagWith(markup, "data-right-panel-tabbar")).toContain("drag-region");

    // -webkit-app-region: drag swallows pointer and wheel events, so the scroll
    // container itself must opt out or the tab strip cannot be scrolled.
    const tabList = tagWith(markup, "data-right-panel-tab-list");
    expect(tabList).toContain("[-webkit-app-region:no-drag]");
    expect(tabList).not.toContain("drag-region");
  });
});
