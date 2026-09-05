import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "./ui/anchoredCopyToast";
import { DiffFileHeaderActionButton } from "./DiffFileHeaderActionButton";

export function DiffFilePathCopyButton({ filePath }: { filePath: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <DiffFileHeaderActionButton
      ref={ref}
      ariaLabel="Copy file path"
      onClick={() => copyToClipboard(filePath, undefined)}
      tooltip={isCopied ? "Copied" : "Copy path"}
    >
      {isCopied ? <CheckIcon aria-hidden className="text-success" /> : <CopyIcon aria-hidden />}
    </DiffFileHeaderActionButton>
  );
}
