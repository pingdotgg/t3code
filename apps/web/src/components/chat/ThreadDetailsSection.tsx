import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";

/** One device-wide choice per section, shared by every thread; unset reads as expanded. */
export function useThreadDetailsSectionCollapsed(section: "children" | "lineage") {
  return useLocalStorage(`t3code:thread-details:${section}-collapsed`, false, Schema.Boolean);
}

export function ThreadDetailsSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  collapsed,
  onCollapsedChange,
  children,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
  /** Passing a handler makes the heading a toggle and always shows it. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const collapsible = onCollapsedChange !== undefined;
  const headingVisible = showHeading || collapsible;
  const contentId = `${headingId}-content`;
  return (
    <section
      {...props}
      aria-labelledby={headingVisible ? headingId : undefined}
      aria-label={headingVisible ? undefined : title}
      // A row can still render nothing (a fresh draft quiets Git actions), so an empty section
      // collapses, and a divider only follows a section that has content.
      className={cn(
        "px-2 pt-2 pb-2.5 has-[>div:last-child:empty]:hidden",
        separated && "border-border/65 [section:not(:has(>div:last-child:empty))~&]:border-t",
        collapsible && collapsed && "pb-2",
      )}
    >
      <div
        className={cn(
          "flex min-h-8 min-w-0 items-center justify-between gap-2 px-2.5",
          !(collapsible && collapsed) && "mb-1",
          !headingVisible && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
        >
          {collapsible ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={collapsed ? undefined : contentId}
              onClick={() => onCollapsedChange(!collapsed)}
              className="-mx-1 flex max-w-full cursor-pointer items-center gap-1 rounded-sm px-1 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            >
              <span className="min-w-0 truncate">{title}</span>
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
              />
            </button>
          ) : (
            title
          )}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {collapsible ? (
        collapsed ? null : (
          <div id={contentId} className="contents">
            {children}
          </div>
        )
      ) : (
        children
      )}
    </section>
  );
}
