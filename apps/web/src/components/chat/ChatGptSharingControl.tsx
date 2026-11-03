import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import type { ServerProvider } from "@t3tools/contracts";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";

export function ChatGptSharingControl({ provider }: { provider: ServerProvider | null }) {
  if (!usesChatGptSharing(provider)) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t px-3 py-2">
      <div className="flex min-w-0 flex-col text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <OpenAI className="size-3.5" aria-hidden="true" />
          Using ChatGPT plan
        </span>
        <span className="pl-5.5">Fast and Ultrafast unavailable</span>
      </div>
      <ChatGptUsageButton size="xs" />
    </div>
  );
}
