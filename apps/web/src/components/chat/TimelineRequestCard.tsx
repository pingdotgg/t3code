import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** Shell for a request an agent is waiting on the user to answer inline in the timeline. */
export function TimelineRequestCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4",
        className,
      )}
      {...props}
    />
  );
}
