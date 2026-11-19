import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

function Section({ title, empty }: { title: string; empty: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-md px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase hover:text-fg"
      >
        {title}
        <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <p className="px-2 py-1 text-faint">{empty}</p>}
    </section>
  );
}

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
      <Section title="Projects" empty="No projects yet" />
      <Section title="Workspace" empty="Nothing here yet" />
      <div className="flex-1" />
      {footer && (
        <div className="flex items-center gap-2 border-t border-line p-2 text-xs text-muted">
          {footer}
        </div>
      )}
    </aside>
  );
}
