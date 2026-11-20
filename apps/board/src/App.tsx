import { useState } from "react";

import { Viewport } from "./board/Viewport";
import { EngineStatus } from "./sidebar/EngineStatus";
import { EngineVersion } from "./sidebar/EngineVersion";
import { SettingsScreen } from "./settings/SettingsScreen";
import { Sidebar } from "./sidebar/Sidebar";
import { UsageBar } from "./usage/UsageBar";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="grid h-full grid-rows-[var(--topbar-height)_minmax(0,1fr)_auto]">
      <header className="drag-region border-b border-line bg-bg" />
      {/* Hidden, not unmounted, so the viewport keeps its pan and zoom while settings are open. */}
      <div className={settingsOpen ? "hidden" : "grid min-h-0 grid-cols-[240px_minmax(0,1fr)]"}>
        <Sidebar
          footer={
            <>
              <EngineStatus />
              <EngineVersion />
            </>
          }
          onOpenSettings={() => {
            performance.mark("board:settings-click");
            setSettingsOpen(true);
          }}
        />
        <main className="min-w-0">
          <Viewport />
        </main>
      </div>
      {settingsOpen && <SettingsScreen onBack={() => setSettingsOpen(false)} />}
      <UsageBar />
    </div>
  );
}
