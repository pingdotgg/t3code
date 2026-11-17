import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { PullRequestGlyph } from "./pullRequestIcons";
import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { MenuGroupLabel } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestStackHeader({
  number,
  size,
  terminology,
  notice,
  stale = false,
  onClose,
}: {
  number: number;
  /** How many pull requests the stack holds, once it has been read. */
  size?: number | undefined;
  terminology: ChangeRequestTerminology;
  notice?: string | null | undefined;
  stale?: boolean;
  onClose?: (() => void) | undefined;
}) {
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-foreground">
          <PullRequestGlyph.stack aria-hidden className="size-3.5 shrink-0" />
          <span>Stack</span>
          <span className="truncate text-meta text-muted-foreground">
            {size === undefined
              ? `#${number}`
              : `${size} ${size === 1 ? terminology.singular : terminology.plural}`}
          </span>
        </span>
        {notice ? (
          <Tooltip>
            <TooltipTrigger render={<span role="status" className="text-meta" />}>
              {stale ? "May be stale" : "Refreshing…"}
            </TooltipTrigger>
            <TooltipPopup>{notice}</TooltipPopup>
          </Tooltip>
        ) : null}
        {onClose ? (
          <Button variant="bare" size="icon-xs" aria-label="Close stack" onClick={onClose}>
            <XIcon />
          </Button>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}
