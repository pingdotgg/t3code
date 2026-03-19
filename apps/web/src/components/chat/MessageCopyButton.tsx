import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

type CopyCallbacks = {
  onCopy?: () => void;
  onError?: (error: Error) => void;
};

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label,
  title = "Copy message",
  disabled = false,
  disabledTitle,
  size = "xs",
  variant = "outline",
  className,
  onCopy,
  onError,
}: {
  text: string;
  label?: string;
  title?: string;
  disabled?: boolean;
  disabledTitle?: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
  onCopy?: () => void;
  onError?: (error: Error) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<CopyCallbacks>({
    onCopy: (callbacks) => {
      callbacks.onCopy?.();
    },
    onError: (error, callbacks) => {
      callbacks.onError?.(error);
    },
  });
  const buttonTitle = disabled ? (disabledTitle ?? title) : isCopied ? "Copied" : title;
  const copyCallbacks = {
    ...(onCopy ? { onCopy } : {}),
    ...(onError ? { onError } : {}),
  };

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={cn(className)}
      disabled={disabled}
      onClick={() => copyToClipboard(text, copyCallbacks)}
      title={buttonTitle}
      aria-label={buttonTitle}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      {label ? <span>{label}</span> : null}
    </Button>
  );
});
