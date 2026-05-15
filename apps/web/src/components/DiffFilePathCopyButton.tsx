import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "./ui/button";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "./ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function DiffFilePathCopyButton({ filePath }: { filePath: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Copy file path"
            onClick={() => copyToClipboard(filePath, undefined)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{isCopied ? "Copied" : "Copy path"}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
