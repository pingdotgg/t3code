import { memo, useRef } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { anchoredToastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;
const onCopy = (ref: React.RefObject<HTMLButtonElement | null>) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: "Copied!",
    });
  }
};

const onCopyError = (ref: React.RefObject<HTMLButtonElement | null>, error: Error) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: "Failed to copy",
      description: error.message,
    });
  }
};

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => onCopy(ref),
    onError: (error: Error) => onCopyError(ref, error),
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy link"
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant}
            className={cn(className)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  );
});
