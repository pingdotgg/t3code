import { Viewport } from "./board/Viewport";
import { Sidebar } from "./sidebar/Sidebar";

export function App() {
  return (
    <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar
        footer={
          <>
            <span className="size-[7px] rounded-full bg-offline" />
            Engine not connected
          </>
        }
      />
      <main className="min-w-0">
        <Viewport />
      </main>
    </div>
  );
}
