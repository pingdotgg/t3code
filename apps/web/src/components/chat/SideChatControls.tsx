import type { ReactNode } from "react";

/** Keep choices in the session; unmount menus when their thread or tab is hidden. */
export function SideChatControls({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {active ? children : null}
    </div>
  );
}
