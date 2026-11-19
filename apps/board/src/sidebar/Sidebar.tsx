import type { ReactNode } from "react";

import { ProjectList } from "./ProjectList";
import { Section } from "./Section";

export function Sidebar({ footer }: { footer?: ReactNode }) {
  return (
    <aside
      aria-label="Sidebar"
      className="flex min-h-0 flex-col gap-1 border-r border-line bg-sidebar px-2.5 py-3"
    >
      <div className="flex items-center gap-2 px-2 pb-3 font-bold tracking-tight">
        <div className="grid size-[22px] place-items-center rounded-md bg-fg text-xs text-bg">
          ab
        </div>
        Agent Board
      </div>
      <Section title="Projects" className="min-h-0 shrink">
        <ProjectList />
      </Section>
      <Section title="Workspace" empty="Nothing here yet" className="shrink-0" />
      <div className="flex-1" />
      {footer && (
        <div className="shrink-0 border-t border-line p-2 text-xs text-muted">{footer}</div>
      )}
    </aside>
  );
}
