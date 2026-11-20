import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Globe, X } from "lucide-react";
import { useContext } from "react";

import { Tooltip } from "../ui/Tooltip";
import { AddressBar } from "./AddressBar";
import { AgentTabView } from "./AgentTabView";
import { browserHost } from "./host";
import { PageArea } from "./PageArea";
import { closePanel, panelAtom, setPanelView } from "./panel";
import { ResizeHandle } from "./ResizeHandle";
import { iconButton } from "./styles";
import { SystemBrowserBar } from "./SystemBrowserBar";
import { TabStrip } from "./TabStrip";

// Two frames: the first commits the panel, the second runs after it has been painted. A stable
// function, so a re-render does not run it again.
function markPainted(node: HTMLElement | null) {
  if (node === null) return;
  const frame = requestAnimationFrame(() =>
    requestAnimationFrame(() => performance.mark("board:browser-painted")),
  );
  return () => cancelAnimationFrame(frame);
}

/** The panel beside the board: the user's tabs inside Electron, and the engine's agent tabs everywhere. */
export function BrowserPanel() {
  const registry = useContext(RegistryContext);
  const { view, width, tabs } = useAtomValue(panelAtom);
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeId) ?? null;
  const showingTabs = browserHost !== null && view === "tabs";
  return (
    <aside
      ref={markPainted}
      aria-label="Browser panel"
      data-testid="browser-panel"
      style={{ width }}
      className="relative flex min-h-0 flex-col border-l border-line bg-sidebar"
    >
      <ResizeHandle />
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {showingTabs ? (
          <TabStrip tabs={tabs.tabs} activeId={tabs.activeId} />
        ) : (
          <h2 className="flex flex-1 items-center gap-2 px-1 font-semibold">
            <Globe className="size-4 text-muted" aria-hidden />
            Agent tabs
          </h2>
        )}
        {browserHost !== null && (
          <button
            type="button"
            aria-pressed={view === "agents"}
            onClick={() => setPanelView(registry, view === "agents" ? "tabs" : "agents")}
            className={`rounded-md px-2 py-1 text-[12px] ${view === "agents" ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg"}`}
          >
            Agents
          </button>
        )}
        <Tooltip text="Close the panel" side="bottom" align="end">
          <button
            type="button"
            aria-label="Close the browser panel"
            onClick={() => closePanel(registry)}
            className={iconButton}
          >
            <X className="size-4" />
          </button>
        </Tooltip>
      </div>
      {showingTabs && <AddressBar key={active?.id} tab={active} />}
      {showingTabs ? <PageArea empty={tabs.tabs.length === 0} /> : <AgentTabView />}
      {browserHost === null && <SystemBrowserBar />}
    </aside>
  );
}
