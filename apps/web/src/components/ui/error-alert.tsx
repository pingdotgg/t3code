import { CheckIcon, CircleAlertIcon, CopyIcon, XIcon } from "lucide-react";
import { memo } from "react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Alert } from "./alert";
import { ScrollArea } from "./scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export const ErrorAlert = memo(function ErrorAlert({
  message,
  title,
  variant = "error",
  onDismiss,
}: {
  message: string;
  title?: string;
  variant?: "error" | "warning";
  onDismiss?: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const accentClass =
    variant === "error"
      ? "text-destructive/60 hover:text-destructive"
      : "text-warning/60 hover:text-warning";

  const buttonClass = cn(
    "inline-flex size-6 cursor-pointer items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    accentClass,
  );

  return (
    // Alert uses CSS grid layout; flex! overrides it intentionally to support a
    // scrollable description alongside top-aligned action buttons.
    <Alert variant={variant} className="flex! gap-2">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        <ScrollArea
          scrollFade
          className={cn(
            "h-auto rounded-none *:data-[slot=scroll-area-viewport]:max-h-28 *:data-[slot=scroll-area-viewport]:rounded-none",
            title && "mt-0.5",
          )}
        >
          <div className="wrap-break-word pr-3 text-muted-foreground">
            {message}
          </div>
        </ScrollArea>
      </div>
      <div className="flex shrink-0 flex-row gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={isCopied ? "Copied" : "Copy message"}
                className={buttonClass}
                onClick={() => copyToClipboard(message)}
              />
            }
          >
            <span className="relative size-3.5">
              <CopyIcon
                className={cn(
                  "absolute inset-0 size-3.5 transition-all duration-150",
                  isCopied ? "scale-75 opacity-0" : "scale-100 opacity-100",
                )}
              />
              <CheckIcon
                className={cn(
                  "absolute inset-0 size-3.5 transition-all duration-150",
                  isCopied ? "scale-100 opacity-100" : "scale-75 opacity-0",
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            <p>{isCopied ? "Copied!" : "Copy message"}</p>
          </TooltipPopup>
        </Tooltip>
        {onDismiss && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Dismiss"
                  className={buttonClass}
                  onClick={onDismiss}
                />
              }
            >
              <XIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>
              <p>Dismiss</p>
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </Alert>
  );
});
