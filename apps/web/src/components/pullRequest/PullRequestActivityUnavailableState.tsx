import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useTranslation } from "@t3tools/i18n/react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

export function PullRequestActivityUnavailableState({
  error,
  onRetry,
  compact = false,
}: {
  error: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("pullRequests");
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "py-3" : "min-h-48 px-4 py-10",
      )}
    >
      <p className="text-sm font-medium text-foreground">{t("couldNotLoadPullRequestActivity")}</p>
      <p className="max-w-md text-xs text-muted-foreground">{error}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshIcon aria-hidden size="sm" />
        {t("retry")}
      </Button>
    </div>
  );
}
