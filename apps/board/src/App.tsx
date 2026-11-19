import { Viewport } from "./board/Viewport";
import { EngineStatus } from "./sidebar/EngineStatus";
import { Sidebar } from "./sidebar/Sidebar";

export function App() {
  return (
    <div className="grid h-full grid-rows-[var(--topbar-height)_minmax(0,1fr)]">
      <header className="drag-region border-b border-line bg-bg" />
      <div className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)]">
        <Sidebar footer={<EngineStatus />} />
        <main className="min-w-0">
          <Viewport />
        </main>
      </div>
    </div>
  );
}
