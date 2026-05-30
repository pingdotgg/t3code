import type { ReactNode } from "react";
import { PanelRightCloseIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export interface ThreadSidebarProps {
  label: string;
  mode?: "sheet" | "sidebar";
  headerMeta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

export function ThreadSidebar({
  label,
  mode = "sidebar",
  headerMeta,
  actions,
  children,
  onClose,
}: ThreadSidebarProps) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-blue-500/10 px-1.5 py-0 text-[10px] font-semibold tracking-wide text-blue-400 uppercase"
          >
            {label}
          </Badge>
          {headerMeta}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label={`Close ${label.toLowerCase()} sidebar`}
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">{children}</div>
      </ScrollArea>
    </div>
  );
}
