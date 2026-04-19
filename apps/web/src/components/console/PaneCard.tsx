import { ChevronDownIcon, ChevronRightIcon, type LucideIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

interface PaneCardProps {
  id: string;
  title: string;
  Icon: LucideIcon;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
  /**
   * Optional right-aligned controls rendered before the chevron + close X.
   * Use sparingly — most cards should rely on collapse + close alone.
   */
  headerActions?: ReactNode;
  children: ReactNode;
}

/**
 * Cowork-style stack card: rounded container with a header (icon + title +
 * optional actions + collapse chevron + close X) and a collapsible body.
 *
 * The card is intentionally a presentational primitive — visibility and
 * collapse state live in the parent rail so they can be persisted and shared.
 */
export function PaneCard({
  id,
  title,
  Icon,
  collapsed,
  onToggleCollapsed,
  onClose,
  headerActions,
  children,
}: PaneCardProps) {
  return (
    <section
      data-pane-id={id}
      data-pane-collapsed={collapsed}
      className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/55 bg-background/55"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/45 px-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? `Expand ${title} card` : `Collapse ${title} card`}
          aria-expanded={!collapsed}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors",
            "hover:text-foreground/95",
          )}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/65" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/65" />
          )}
          <Icon className="size-3.5 shrink-0 text-muted-foreground/75" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
            {title}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label={`Close ${title} card`}
            title={`Close ${title} card`}
            className="text-muted-foreground/55 hover:text-foreground/80"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </header>
      {collapsed ? null : <div className="flex min-h-0 flex-col">{children}</div>}
    </section>
  );
}
