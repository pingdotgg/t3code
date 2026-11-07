import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import type { ServerProvider } from "@t3tools/contracts";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ChatGptSharingControl({ provider }: { provider: ServerProvider | null }) {
  if (!usesChatGptSharing(provider)) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t px-3 py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="flex items-center gap-2 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <OpenAI className="size-3.5" aria-hidden="true" />
          Using ChatGPT plan
        </TooltipTrigger>
        <TooltipPopup side="top">
          Fast and Ultrafast are unavailable with this ChatGPT connection. Use an existing Codex CLI
          login for speed options your account supports.
        </TooltipPopup>
      </Tooltip>
      <ChatGptUsageButton size="xs" />
    </div>
  );
}
