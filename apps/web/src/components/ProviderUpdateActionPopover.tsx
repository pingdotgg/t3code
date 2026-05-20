import type { ReactElement, ReactNode } from "react";
import { CopyIcon, DownloadIcon, LoaderIcon } from "lucide-react";

import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ProviderUpdateActionPopoverProps {
  readonly trigger: ReactElement;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly updateCommand: string | null;
  readonly canRunUpdate?: boolean;
  readonly isUpdating?: boolean;
  readonly runLabel?: string;
  readonly runningLabel?: string;
  readonly manualDividerLabel?: string;
  readonly copyLabel?: string;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly onCopyCommand?: ((command: string) => void) | undefined;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
}

export function ProviderUpdateActionPopover({
  trigger,
  title,
  detail,
  updateCommand,
  canRunUpdate = false,
  isUpdating = false,
  runLabel = "Update now",
  runningLabel = "Updating",
  manualDividerLabel = "or, update manually using",
  copyLabel = "Copy update command",
  onRunUpdate,
  onCopyCommand,
  side = "bottom",
  align = "start",
}: ProviderUpdateActionPopoverProps) {
  const showRunButton = canRunUpdate && onRunUpdate !== undefined;
  const showManualDivider = showRunButton && updateCommand !== null;

  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        side={side}
        align={align}
        className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
      >
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-[13px] font-semibold leading-tight text-foreground">{title}</p>
            <p className="text-xs leading-snug text-muted-foreground">{detail}</p>
          </div>
          {showRunButton ? (
            <Button
              type="button"
              size="xs"
              variant="default"
              className="w-full"
              disabled={isUpdating}
              onClick={onRunUpdate}
            >
              {isUpdating ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
              {isUpdating ? runningLabel : runLabel}
            </Button>
          ) : null}
          {showManualDivider ? (
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />
              {manualDividerLabel}
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          {updateCommand ? (
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
              <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                  {updateCommand}
                </code>
              </ScrollArea>
              {onCopyCommand ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => onCopyCommand(updateCommand)}
                        aria-label={copyLabel}
                      >
                        <CopyIcon className="size-3" />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Copy command</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
