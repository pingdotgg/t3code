import type { ComponentProps, ReactNode } from "react";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";
import { TooltipPopup } from "./ui/tooltip";
import { cn } from "~/lib/utils";

const HOVER_CARD_CLASS_NAME = "max-w-80 text-left whitespace-normal";

export function ThreadHoverCardPopup({ className, ...props }: ComponentProps<typeof TooltipPopup>) {
  return (
    <TooltipPopup {...props} variant="glass" className={cn(HOVER_CARD_CLASS_NAME, className)} />
  );
}

/** A thread hover card on `render`, drawn by the shared tooltip so a list of rows mounts none. */
export function ThreadHoverCardTrigger({
  card,
  side = "right",
  align = "start",
  sideOffset = 4,
  ...props
}: Omit<ComponentProps<typeof SharedTooltipTrigger>, "label" | "variant" | "className"> & {
  card: ReactNode;
}) {
  return (
    <SharedTooltipTrigger
      {...props}
      label={card}
      side={side}
      align={align}
      sideOffset={sideOffset}
      variant="glass"
      className={HOVER_CARD_CLASS_NAME}
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
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}
