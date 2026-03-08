import type { ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { SidebarTrigger } from "./ui/sidebar";

interface ChatShellHeaderBarProps {
  title: string;
  titleClassName?: string;
  trailing?: ReactNode;
}

export default function ChatShellHeaderBar({
  title,
  titleClassName,
  trailing,
}: ChatShellHeaderBarProps) {
  if (isElectron) {
    return (
      <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="size-7 shrink-0" />
          <span className={cn("truncate text-sm text-foreground", titleClassName)}>{title}</span>
        </div>
        {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
      </div>
    );
  }

  return (
    <header className="border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="size-7 shrink-0" />
        <span className={cn("truncate text-sm font-medium text-foreground", titleClassName)}>
          {title}
        </span>
        {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
      </div>
    </header>
  );
}
