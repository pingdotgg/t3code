import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { definePluginComponent } from "~/plugins/features";

export const StartTruncatedPath = definePluginComponent(
  "component:components/StartTruncatedPath/StartTruncatedPath",
  PluginOriginalStartTruncatedPath,
);

function PluginOriginalStartTruncatedPath({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left",
              className,
            )}
            dir="rtl"
          />
        }
      >
        <bdi>{path}</bdi>
      </TooltipTrigger>
      <TooltipPopup side="top" variant="code">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}
