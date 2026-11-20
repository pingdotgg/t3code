import { useAtomValue } from "@effect/atom-react";

import { ChangesPanel } from "../changes/ChangesPanel";
import { FilesPanel } from "../files/FilesPanel";
import { lastOpenedBoardAtom } from "../state/boards";
import { EmptyFiles } from "../files/EmptyFiles";
import { attachChatSlot, attachChecksSlot, panelAtom } from "./panel";
import { PanelTabs } from "./PanelTabs";
import { ResizeHandle } from "./ResizeHandle";

const shown = (active: boolean) => (active ? "flex min-h-0 flex-1 flex-col" : "hidden");

/**
 * The one panel beside the board. Its tabs share one width, and every tab stays mounted behind the
 * others, so the chat keeps its scroll, draft, and stream, the explorer its open folders, and
 * source control its commit message.
 */
export function PanelHost() {
  const { open, tab, width } = useAtomValue(panelAtom);
  const opened = useAtomValue(lastOpenedBoardAtom);
  return (
    <aside
      aria-label="Side panel"
      data-testid="side-panel"
      style={{ width }}
      className={`relative min-h-0 flex-col border-l border-line bg-sidebar ${open ? "flex" : "hidden"}`}
    >
      <ResizeHandle />
      <PanelTabs />
      <div
        id="panel-chat"
        role="tabpanel"
        aria-labelledby="panel-tab-chat"
        className={shown(tab === "chat")}
      >
        {opened === null && <EmptyFiles>Open a board to talk to its orchestrator.</EmptyFiles>}
        {/* The board's own screen draws the chat into this slot, because the chat needs the board's context. */}
        <div ref={attachChatSlot} className="flex min-h-0 flex-1 flex-col" />
      </div>
      <div
        id="panel-explorer"
        role="tabpanel"
        aria-labelledby="panel-tab-explorer"
        className={shown(tab === "explorer")}
      >
        <FilesPanel />
      </div>
      <div
        id="panel-changes"
        role="tabpanel"
        aria-labelledby="panel-tab-changes"
        className={shown(tab === "changes")}
      >
        <ChangesPanel />
      </div>
      <div
        id="panel-checks"
        role="tabpanel"
        aria-labelledby="panel-tab-checks"
        className={shown(tab === "checks")}
      >
        {opened === null && <EmptyFiles>Open a board to see its pull requests.</EmptyFiles>}
        {/* The board's own screen draws the checks into this slot, because they need its tickets and pull request context. */}
        <div ref={attachChecksSlot} className="flex min-h-0 flex-1 flex-col" />
      </div>
    </aside>
  );
}
