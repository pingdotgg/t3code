import { InfoIcon } from "lucide-react";
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
  if (error) {
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground"
        aria-label="Retry loading diff"
        onClick={(event) => {
          event.stopPropagation();
          retry();
        }}
      >
        Retry loading diff
      </button>
    );
  }
  if (!truncated) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="text-muted-foreground"
            aria-label="Partial diff preview"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <InfoIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>
        This file is too large to show in full. Counts include all changes.
      </TooltipPopup>
    </Tooltip>
  );
}
