import { ChevronDown } from "lucide-react";
import { useState } from "react";

export function Section({ title, empty }: { title: string; empty: string }) {
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
