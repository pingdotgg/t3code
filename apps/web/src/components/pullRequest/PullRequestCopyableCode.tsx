import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestCopyableCode({
  value,
  target,
  copyLabel,
  copiedLabel,
  className,
  tooltipSide = "top",
  onError,
}: {
  readonly value: string;
  readonly target: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
  readonly className?: string;
  readonly tooltipSide?: "top" | "bottom";
  readonly onError?: (error: Error) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target,
    timeout: 1600,
    ...(onError ? { onError } : {}),
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "relative grid w-fit min-w-0 max-w-full shrink cursor-pointer rounded px-1 py-0.5 text-left outline-none transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent/45 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              className,
            )}
            aria-label={isCopied ? copiedLabel : copyLabel}
            onClick={() => copyToClipboard(value)}
          />
        }
      >
        <code
          className={cn(
            "col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-150 motion-reduce:transition-none",
            isCopied ? "opacity-0" : "opacity-100",
          )}
        >
          {value}
        </code>
        <span
          aria-hidden="true"
          className={cn(
            "col-start-1 row-start-1 truncate text-center transition-opacity duration-150 motion-reduce:transition-none",
            isCopied ? "opacity-100" : "opacity-0",
          )}
        >
          Copied
        </span>
      </TooltipTrigger>
      <TooltipPopup variant="code" side={tooltipSide}>
        {`${isCopied ? "Copied" : copyLabel}: ${value}`}
      </TooltipPopup>
    </Tooltip>
  );
}
