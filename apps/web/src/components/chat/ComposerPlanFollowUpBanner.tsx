import { memo } from "react";
import { ComposerBanner } from "./ComposerBanner";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon />
      <ComposerBanner.Content>
        <span className="shrink-0 font-medium text-foreground">Plan ready</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate font-normal text-dim-foreground">
            {planTitle}
          </span>
        ) : null}
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
});
