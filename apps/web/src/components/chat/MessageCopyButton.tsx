import { memo, useRef } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { localizedClipboardErrorMessage, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { anchoredToastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useI18n } from "../../i18n/I18nProvider";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;
const onCopy = (ref: React.RefObject<HTMLButtonElement | null>, title: string) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title,
    });
  }
};

const onCopyError = (
  ref: React.RefObject<HTMLButtonElement | null>,
  description: string,
  title: string,
) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title,
      description,
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
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => onCopy(ref, t("chat.copy.success")),
    onError: (error) =>
      onCopyError(ref, localizedClipboardErrorMessage(error, t), t("chat.copy.failed")),
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={t("chat.copy.link")}
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant}
            className={cn("text-muted-foreground hover:text-foreground", className)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{t("chat.copy")}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
