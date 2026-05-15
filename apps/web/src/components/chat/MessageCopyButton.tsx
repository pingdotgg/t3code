import { memo, useRef } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
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
