import { cn } from "~/lib/utils";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";

export function StartTruncatedPath({ path, className }: { path: string; className?: string }) {
  return (
    <SharedTooltipTrigger
      render={
        <span
          className={cn(
            "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left",
            className,
          )}
          dir="rtl"
        />
      }
      label={path}
      variant="code"
    >
      <bdi>{path}</bdi>
    </SharedTooltipTrigger>
  );
}
