import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function StartTruncatedPath({
  path,
  displayPath = path,
  className,
}: {
  path: string;
  displayPath?: string;
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
        <bdi>{displayPath}</bdi>
      </TooltipTrigger>
      <TooltipPopup side="top" variant="code">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}
