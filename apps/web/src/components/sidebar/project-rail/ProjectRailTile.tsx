import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/**
 * One square button in the rail. The squircle-to-rounded-square transition and
 * the left-edge pill are the Discord affordances that make a column of icons
 * readable as a selector; both are finite transitions, never a running
 * animation.
 */
export function ProjectRailTile({
  active,
  label,
  secondaryLabel,
  children,
  onClick,
  onContextMenu,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly secondaryLabel?: string | undefined;
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly onContextMenu?: ((event: ReactMouseEvent<HTMLElement>) => void) | undefined;
}) {
  return (
    <div className="group/rail-tile relative flex w-full justify-center">
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-foreground transition-[height,opacity] duration-150 ease-out",
          active ? "h-5 opacity-100" : "h-2 opacity-0 group-hover/rail-tile:opacity-60",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              aria-pressed={active}
              onClick={onClick}
              {...(onContextMenu ? { onContextMenu } : {})}
              className={cn(
                "flex size-10 cursor-pointer items-center justify-center overflow-hidden rounded-2xl outline-hidden ring-ring transition-[border-radius,background-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                active
                  ? "rounded-xl bg-sidebar-row-selected"
                  : "bg-sidebar-control-surface hover:rounded-xl hover:bg-sidebar-row-hover",
              )}
            >
              {children}
            </button>
          }
        />
        <TooltipPopup side="right">
          {secondaryLabel ? (
            <span className="flex flex-col gap-0.5">
              <span>{label}</span>
              <span className="text-muted-foreground">{secondaryLabel}</span>
            </span>
          ) : (
            label
          )}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
