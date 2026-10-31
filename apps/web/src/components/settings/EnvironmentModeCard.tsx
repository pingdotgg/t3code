import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** The selectable card used for connection modes and sandbox providers. */
export function EnvironmentModeCard({
  selected,
  disabled,
  title,
  description,
  icon,
  badge,
  onClick,
}: {
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly title: string;
  readonly description: string;
  readonly icon?: ReactNode;
  readonly badge?: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "group flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left",
        selected ? "border-primary/50 bg-primary/5" : "border-border/60 hover:bg-muted/40",
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? (
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border",
            selected
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-border/70 bg-background text-muted-foreground group-hover:text-foreground",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {badge}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
