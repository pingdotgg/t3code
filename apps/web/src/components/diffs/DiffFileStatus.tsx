import { translate } from "@t3tools/i18n";
import { InfoIcon, RotateCwIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function DiffFileStatus({
  error,
  truncated,
  retry,
}: {
  error?: boolean | undefined;
  truncated?: boolean | undefined;
  retry: () => void;
}) {
  if (!error && !truncated) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={
              error
                ? translate("diffs:retryLoadingDiff", "Retry loading diff")
                : translate("common:uiPartialDiffPreview", "Partial diff preview")
            }
            onClick={(event) => {
              event.stopPropagation();
              if (error) retry();
            }}
          />
        }
      >
        {error ? <RotateCwIcon className="size-3" /> : <InfoIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        {translate(
          error ? "diffs:retryLoadingDiff" : "diffs:fileTooLarge",
          error
            ? "Retry loading diff"
            : "This file is too large to show in full. Counts include all changes.",
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
