import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";

export function Section({
  title,
  className = "",
  actions,
  children,
}: {
  title: string;
  className?: string;
  /** Small icon buttons on the right of the header. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`flex flex-col ${className}`}>
      <div className="flex shrink-0 items-center justify-between pt-3 pb-1 pr-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 rounded-md px-2 text-[13px] font-medium text-muted hover:text-fg"
        >
          {title}
          <ChevronDown className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      {open && children}
    </section>
  );
}
