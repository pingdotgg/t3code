import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

interface PanelTabProps extends ComponentProps<"div"> {
  active: boolean;
}

export function PanelTab({ active, className, ...props }: PanelTabProps) {
  return (
    <div
      {...props}
      data-active-tab={active}
      className={cn(
        "group/tab flex h-6 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    />
  );
}
