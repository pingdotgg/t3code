import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils";

/** Sections share header and content insets in both the sidebar and popover. */
export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
}) {
  return (
    <section
      {...props}
      aria-labelledby={headingId}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      <div className="mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-1.5">
        <h3
          id={headingId}
          className="min-w-0 truncate text-[11px] font-medium text-muted-foreground select-none"
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
