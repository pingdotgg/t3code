import type { ComponentProps, ReactNode } from "react";
import { TooltipPopup } from "./ui/tooltip";
import { cn } from "~/lib/utils";

export function ThreadHoverCardPopup({ className, ...props }: ComponentProps<typeof TooltipPopup>) {
  return (
    <TooltipPopup
      {...props}
      variant="thread"
      className={cn("max-w-80 text-left whitespace-normal", className)}
    />
  );
}

export function ThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2">
      <div className="min-w-0 truncate text-meta leading-tight font-semibold text-strong-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 text-meta font-normal text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}
