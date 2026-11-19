import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

export function Section({
  title,
  empty,
  className = "",
  children,
}: {
  title: string;
  empty?: string;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`flex flex-col ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full shrink-0 items-center justify-between rounded-md px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase hover:text-fg"
      >
        {title}
        <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (children ?? <p className="px-2 py-1 text-faint">{empty}</p>)}
    </section>
  );
}
