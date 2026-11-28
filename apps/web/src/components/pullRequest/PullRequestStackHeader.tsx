import { T, useGT, Var } from "gt-react";

import { MenuGroupLabel } from "../ui/menu";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function PullRequestStackHeader({
  number,
  notice,
  stale = false,
}: {
  number: number;
  notice?: string | null | undefined;
  stale?: boolean;
}) {
  const gt = useGT();
  return (
    <MenuGroupLabel>
      <div className="flex items-center justify-between gap-2">
        <span>
          <T>
            Stack #<Var>{number}</Var>
          </T>
        </span>
        {notice ? (
          <SharedTooltipTrigger
            render={<span role="status" className="text-xs font-normal" />}
            label={notice}
          >
            {stale ? gt("May be stale") : gt("Refreshing…")}
          </SharedTooltipTrigger>
        ) : null}
      </div>
    </MenuGroupLabel>
  );
}
