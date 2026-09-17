import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";

const tones = {
  muted: { label: "text-sidebar-muted-foreground/60", line: "bg-sidebar-border/60" },
  info: { label: "text-blue-600 dark:text-blue-400", line: "bg-blue-500/20 dark:bg-blue-400/15" },
  emphasized: { label: "text-sidebar-foreground/80", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

/** Callers own the section state and content; this owns all header geometry. */
export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  accessory,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  accessory?: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        tones[tone].label,
      )}
    >
      <span className="shrink-0">{children}</span>
      <span aria-hidden className={cn("h-px min-w-2 flex-1", tones[tone].line)} />
      {accessory}
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
      />
    </button>
  );
}

export function SectionHeaderStatus({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-[10px] leading-none text-destructive-foreground">
      {children}
    </span>
  );
}
