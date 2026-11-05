import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
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
              error ? t({ message: "Retry loading diff" }) : t({ message: "Partial diff preview" })
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
        {error ? (
          <Trans>Retry loading diff</Trans>
        ) : (
          <Trans>This file is too large to show in full. Counts include all changes.</Trans>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
