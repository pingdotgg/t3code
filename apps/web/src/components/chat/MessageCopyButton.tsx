import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  title = "Copy message",
  size = "xs",
  variant = "outline",
  className,
  disabled = false,
  onCopy,
  onError,
}: {
  text: string;
  title?: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
  disabled?: boolean;
  onCopy?: () => void;
  onError?: (error: Error) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    ...(onCopy ? { onCopy: () => onCopy() } : {}),
    ...(onError ? { onError: (error: Error) => onError(error) } : {}),
  });
  const buttonTitle = isCopied ? "Copied" : title;

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={cn(className)}
      disabled={disabled}
      onClick={() => copyToClipboard(text, undefined)}
      title={buttonTitle}
      aria-label={buttonTitle}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
