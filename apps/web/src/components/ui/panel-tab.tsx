import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

interface PanelTabProps extends ComponentProps<"div"> {
  active: boolean;
  noDrag?: boolean;
}

export function PanelTab({ active, noDrag = false, className, ...props }: PanelTabProps) {
  return (
    <div
      {...props}
      data-active-tab={active}
      className={cn(
        "group/tab flex h-6 cursor-pointer items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
        noDrag && "[-webkit-app-region:no-drag]",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    />
  );
}
