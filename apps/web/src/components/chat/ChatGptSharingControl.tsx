import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import type { ServerProvider } from "@t3tools/contracts";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ChatGptSharingControl({ provider }: { provider: ServerProvider | null }) {
  const { t } = useTranslation("composer");
  const speedNoticeId = useId();
  if (!usesChatGptSharing(provider)) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t px-3 py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-describedby={speedNoticeId}
              tabIndex={0}
              className="flex items-center gap-2 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <OpenAI className="size-3.5" aria-hidden="true" />
          {t("chatgpt.usingPlan")}
        </TooltipTrigger>
        <span id={speedNoticeId} className="sr-only">
          {t("chatgpt.speedNotice")}
        </span>
        <TooltipPopup side="top">{t("chatgpt.speedNotice")}</TooltipPopup>
      </Tooltip>
      <ChatGptUsageButton size="xs" />
    </div>
  );
}
