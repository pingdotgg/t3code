import type { ComponentProps, ReactNode } from "react";
import { TooltipPopup } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import { definePluginComponent } from "~/plugins/features";

export const ThreadHoverCardPopup = definePluginComponent(
  "component:components/ThreadHoverCard/ThreadHoverCardPopup",
  PluginOriginalThreadHoverCardPopup,
);
export const ThreadHoverCard = definePluginComponent(
  "component:components/ThreadHoverCard/ThreadHoverCard",
  PluginOriginalThreadHoverCard,
);

function PluginOriginalThreadHoverCardPopup({
  className,
  ...props
}: ComponentProps<typeof TooltipPopup>) {
  return (
    <TooltipPopup
      {...props}
      variant="glass"
      className={cn("max-w-80 text-left whitespace-normal", className)}
    />
  );
}

function PluginOriginalThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}
