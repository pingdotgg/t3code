import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { T, useGT } from "gt-react";
import { PullRequestGlyph } from "./pullRequestIcons";
import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { changeRequestTermKind } from "./changeRequestTerm";
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
  const gt = useGT();
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-foreground">
          <PullRequestGlyph.stack aria-hidden className="size-3.5 shrink-0" />
          <span>
            <T context="noun, a stack of pull requests">Stack</T>
          </span>
          <span className="truncate text-meta text-muted-foreground">
            {size === undefined
              ? `#${number}`
              : gt(
                  "{count, plural, one {{count} {term, select, mr {merge request} cr {change request} other {pull request}}} other {{count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}}}",
                  { count: size, term: changeRequestTermKind(terminology) },
                )}
          </span>
        </span>
        {notice ? (
          <Tooltip>
            <TooltipTrigger render={<span role="status" className="text-meta" />}>
              {stale ? gt("May be stale") : gt("Refreshing…")}
            </TooltipTrigger>
            <TooltipPopup>{notice}</TooltipPopup>
          </Tooltip>
        ) : null}
        {onClose ? (
          <Button variant="bare" size="icon-xs" aria-label={gt("Close stack")} onClick={onClose}>
            <XIcon />
          </Button>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}
