import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Globe } from "lucide-react";
import { useContext } from "react";

import { AddressBar } from "./AddressBar";
import { AgentTabView } from "./AgentTabView";
import { browserHost } from "./host";
import { PageArea } from "./PageArea";
import { panelAtom, setPanelView } from "./panel";
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

/** The browser tab: the user's tabs inside Electron, and the engine's agent tabs everywhere. */
export function BrowserPanel() {
  const registry = useContext(RegistryContext);
  const { view, tabs } = useAtomValue(panelAtom);
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeId) ?? null;
  const showingTabs = browserHost !== null && view === "tabs";
  return (
    <div
      ref={markPainted}
      aria-label="Browser panel"
      data-testid="browser-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
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
      </div>
      {showingTabs && <AddressBar key={active?.id} tab={active} />}
      {showingTabs ? <PageArea empty={tabs.tabs.length === 0} /> : <AgentTabView />}
      {browserHost === null && <SystemBrowserBar />}
    </div>
  );
}
