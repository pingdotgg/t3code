import { RefreshCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

/** Keep the refresh glyph in place while its owning action is running. */
export function RefreshIcon({
  refreshing = false,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof RefreshCwIcon> & { refreshing?: boolean }) {
  return (
    <RefreshCwIcon
      aria-hidden
      ref={refreshing ? observeVisibleAnimation : undefined}
      className={cn(refreshing && "motion-safe:visible-animate-spin", className)}
      {...props}
    />
  );
}
