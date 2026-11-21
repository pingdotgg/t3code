import { useGT } from "gt-react";
import { InfoIcon, RotateCwIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { definePluginComponent } from "~/plugins/features";

export const DiffFileStatus = definePluginComponent(
  "component:components/diffs/DiffFileStatus/DiffFileStatus",
  PluginOriginalDiffFileStatus,
);

function PluginOriginalDiffFileStatus({
  error,
  truncated,
  retry,
}: {
  error?: boolean | undefined;
  truncated?: boolean | undefined;
  retry: () => void;
}) {
  const gt = useGT();
  if (!error && !truncated) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={error ? gt("Retry loading diff") : gt("Partial diff preview")}
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
        {error
          ? gt("Retry loading diff")
          : gt("This file is too large to show in full. Counts include all changes.")}
      </TooltipPopup>
    </Tooltip>
  );
}
