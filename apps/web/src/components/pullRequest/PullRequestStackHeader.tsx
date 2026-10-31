import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { PullRequestGlyph } from "./pullRequestIcons";
import { MenuGroupLabel } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestStackHeader({
  number,
  size,
  terminology,
  notice,
  stale = false,
}: {
  number: number;
  /** How many pull requests the stack holds, once it has been read. */
  size?: number | undefined;
  terminology: ChangeRequestTerminology;
  notice?: string | null | undefined;
  stale?: boolean;
}) {
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-foreground">
          <PullRequestGlyph.stack aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {size === undefined
              ? `Stack #${number}`
              : `Stack · ${size} ${size === 1 ? terminology.singular : terminology.plural}`}
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
      </div>
    </MenuGroupLabel>
  );
}
