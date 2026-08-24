import { memo } from "react";
import { useI18n } from "~/i18n";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  const { t } = useI18n();
  return (
    <div className="px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("chat.plan.ready")}</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{planTitle}</span>
        ) : null}
      </div>
      {/* <div className="mt-2 text-xs text-muted-foreground">
        Review the plan
      </div> */}
    </div>
  );
});
