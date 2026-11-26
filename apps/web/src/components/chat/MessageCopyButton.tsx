import { useGT } from "gt-react";
import { memo, useRef } from "react";
import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
} from "../ui/anchoredCopyToast";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label: labelProp,
  icon: Icon = CopyIcon,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  icon?: LucideIcon;
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const gt = useGT();
  const label = labelProp ?? gt("Copy message");
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <SharedTooltipTrigger
      render={
        <Button
          aria-label={label}
          disabled={isCopied}
          onClick={() => copyToClipboard(text)}
          ref={ref}
          type="button"
          size={size}
          variant={variant === "ghost" ? "ghost-muted" : variant}
          className={className}
        />
      }
      label={
        <>
          <p>{label}</p>
        </>
      }
    >
      {isCopied ? <CheckIcon className="size-3 text-primary" /> : <Icon className="size-3" />}
    </SharedTooltipTrigger>
  );
});
