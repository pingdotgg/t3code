import { memo } from "react";
import { Badge } from "../ui/badge";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="info"
          size="sm"
          className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
        >
          Plan Ready
        </Badge>
        {planTitle ? (
          <span dir="auto" className="min-w-0 flex-1 truncate text-sm font-medium">
            {planTitle}
          </span>
        ) : null}
      </div>
      {/* <div className="mt-2 text-xs text-muted-foreground">
        Review the plan
      </div> */}
    </div>
  );
});
