import type * as React from "react";

import { cn } from "~/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
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

/**
 * A shortcut badge riding on the control it fires, rather than in a legend
 * that names the control a second time. Tinted from the button's own text
 * colour, so one badge sits correctly on a filled button and an outlined one.
 *
 * Hidden from assistive technology, which reaches the control by its label,
 * and from coarse pointers, where there is no key to press.
 */
function KbdHint({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      aria-hidden
      className={cn(
        // The same optical inset the button gives its icons, so a badge that
        // replaces one does not shift the label.
        "-mx-0.5 pointer-events-none inline-flex h-4 min-w-4 select-none items-center justify-center rounded-sm bg-current/12 px-1 font-medium font-sans text-[11px] leading-none pointer-coarse:hidden",
        className,
      )}
      data-slot="kbd-hint"
      {...props}
    />
  );
}

export { Kbd, KbdGroup, KbdHint };
