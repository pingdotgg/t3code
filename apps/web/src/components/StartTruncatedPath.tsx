import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function StartTruncatedPath({ path, className }: { path: string; className?: string }) {
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
      <TooltipPopup side="top" className="max-w-sm break-all font-mono">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}
