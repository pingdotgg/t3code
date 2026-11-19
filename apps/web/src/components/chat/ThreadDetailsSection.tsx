import { useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  showHeading = true,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  showHeading?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = `${headingId}-content`;
  return (
    <section
      {...props}
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className="rounded-2xl border border-border/65 bg-card px-2 pt-2 pb-2.5 has-[>div:last-child:empty]:hidden has-[>div:last-child>div:last-child:empty]:hidden"
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 flex-1 text-2xs font-medium text-muted-foreground select-none"
        >
          <CollapsibleSectionHeader
            variant="card"
            expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded(!expanded)}
          >
            {title}
          </CollapsibleSectionHeader>
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div id={contentId} hidden={showHeading && !expanded}>
        {children}
      </div>
    </section>
  );
}
