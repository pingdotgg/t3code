import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { useGT } from "gt-react";
import { cn } from "~/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { ANCHORED_COPY_TOAST_TIMEOUT_MS, showAnchoredCopyErrorToast } from "./ui/anchoredCopyToast";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function DiffFilePathCopyButton({
  filePath,
  workspaceRoot,
}: {
  filePath: string;
  workspaceRoot: string | undefined;
}) {
  const gt = useGT();
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            size="icon-micro"
            variant="ghost-muted"
            aria-label={gt("Copy file path")}
            onClick={() =>
              copyToClipboard(formatFilePathForClipboard(filePath, workspaceRoot), undefined)
            }
          />
        }
      >
        {isCopied ? (
          <CheckIcon className={cn("size-3", isCopied ? "text-success" : "text-dim-foreground")} />
        ) : (
          <CopyIcon className={cn("size-3", isCopied ? "text-success" : "text-dim-foreground")} />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{isCopied ? gt("Copied") : gt("Copy path")}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
