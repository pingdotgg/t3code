import { useGT } from "gt-react";
import { LockIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { TooltipPopup } from "../ui/tooltip";
import { RowTooltip } from "../workItem/WorkItemRowTooltip";

export function PullRequestPrivateMark({ className }: { className?: string }) {
  const gt = useGT();
  const label = gt("Private");
  return (
    <RowTooltip
      render={<LockIcon role="img" aria-label={label} className={cn("shrink-0", className)} />}
      popup={<TooltipPopup side="top">{label}</TooltipPopup>}
    />
  );
}

export function PullRequestPrivateBadge() {
  const gt = useGT();
  return (
    <Badge size="lg" variant="outline">
      <span className="flex items-center gap-1 text-muted-foreground">
        <LockIcon className="size-3.5" />
        {gt("Private")}
      </span>
    </Badge>
  );
}

export function PullRequestDetailTitleRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-h-7 min-w-0 items-center sm:min-h-6", className)} {...props} />
  );
}
