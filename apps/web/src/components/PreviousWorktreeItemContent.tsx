import { HistoryIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MiddleTruncate } from "./ui/middle-truncate";

export function PreviousWorktreeItemContent({ branch }: { branch: string | null }) {
  const { t } = useTranslation("git");
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <HistoryIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span>{t("branch.previousWorktree")}</span>
        {branch ? (
          <span className="min-w-0 text-xs text-muted-foreground">
            <MiddleTruncate value={branch} />
          </span>
        ) : null}
      </span>
    </span>
  );
}
