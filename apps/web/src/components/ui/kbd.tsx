import type * as React from "react";

import { cn } from "~/lib/utils";

// Colors come from the nearest kbd-in-* / kbd-on-* context (buttons,
// fields, menus, popovers, tooltips set one), falling back to the standalone
// key hint: the kbd recipe with a muted label.
function Kbd({ className, size = "default", ...props }: React.ComponentProps<"kbd"> & { size?: "default" | "sm" }) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-[var(--kbd-radius,var(--radius-badge))] px-1 font-sans text-caption text-[color:var(--kbd-foreground,var(--contrast-muted-foreground))] [background:var(--kbd-background,var(--kbd-fill))] [box-shadow:var(--kbd-box-shadow,var(--kbd-shadow))] [&_svg:not([class*='size-'])]:size-3",
        size === "sm" && "h-4.5 min-w-0 gap-0 px-1.25",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
