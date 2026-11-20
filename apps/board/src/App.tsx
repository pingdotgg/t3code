import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { OpenBoard } from "./board/OpenBoard";
import { panelAtom } from "./browser/panel";
import { PanelHost } from "./browser/PanelHost";
import { PanelToggle } from "./browser/PanelToggle";
import { EngineStatus } from "./sidebar/EngineStatus";
import { EngineVersion } from "./sidebar/EngineVersion";
import { SettingsScreen } from "./settings/SettingsScreen";
import type { SettingsPage } from "./settings/SettingsNav";
import { Sidebar } from "./sidebar/Sidebar";
import { UpdateToasts } from "./sidebar/UpdateToasts";
import { updateWatcherAtom } from "./state/updatesAtoms";
import { UsageBar } from "./usage/UsageBar";

export function App() {
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const panelOpen = useAtomValue(panelAtom).open;
  useAtomMount(updateWatcherAtom);
  return (
    <div className="grid h-full grid-rows-[var(--topbar-height)_minmax(0,1fr)_auto]">
      <header className="drag-region flex items-center justify-end border-b border-line bg-bg px-2">
        <PanelToggle />
      </header>
      {/* Hidden, not unmounted, so the viewport keeps its pan and zoom while settings are open. */}
      <div
        className={
          settingsPage !== null
            ? "hidden"
            : "grid min-h-0 grid-cols-[240px_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)]"
        }
      >
        <Sidebar
          footer={
            <>
              <EngineStatus />
              <EngineVersion />
            </>
          }
          onOpenSettings={() => {
            performance.mark("board:settings-click");
            setSettingsPage("worktrees");
          }}
        />
        <main className="min-h-0 min-w-0">
          <OpenBoard />
        </main>
        {panelOpen && <PanelHost />}
      </div>
      {settingsPage !== null && (
        <SettingsScreen
          page={settingsPage}
          onPage={setSettingsPage}
          onBack={() => setSettingsPage(null)}
        />
      )}
      <UpdateToasts onOpen={() => setSettingsPage("updates")} />
      <UsageBar />
    </div>
  );
}
