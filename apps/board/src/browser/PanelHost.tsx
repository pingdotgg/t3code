import { useAtomValue } from "@effect/atom-react";

import { FilesPanel } from "../files/FilesPanel";
import { BrowserPanel } from "./BrowserPanel";
import { panelAtom } from "./panel";
import { PanelTabs } from "./PanelTabs";
import { ResizeHandle } from "./ResizeHandle";

/**
 * The panel beside the board. Its tabs share one width, and the files tab stays mounted behind
 * the others so an open file and its edits survive a tab switch.
 */
export function PanelHost() {
  const { tab, width } = useAtomValue(panelAtom);
  return (
    <aside
      aria-label="Side panel"
      data-testid="side-panel"
      style={{ width }}
      className="relative flex min-h-0 flex-col border-l border-line bg-sidebar"
    >
      <ResizeHandle />
      <PanelTabs />
      <div
        id="panel-files"
        role="tabpanel"
        aria-labelledby="panel-tab-files"
        className={tab === "files" ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
        <FilesPanel />
      </div>
      {tab === "browser" && (
        <div
          id="panel-browser"
          role="tabpanel"
          aria-labelledby="panel-tab-browser"
          className="flex min-h-0 flex-1 flex-col"
        >
          <BrowserPanel />
        </div>
      )}
    </aside>
  );
}
