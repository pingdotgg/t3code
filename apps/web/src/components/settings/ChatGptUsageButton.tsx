import { T } from "gt-react";
import type { ComponentProps } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { definePluginComponent } from "~/plugins/features";

export const ChatGptUsageButton = definePluginComponent(
  "component:components/settings/ChatGptUsageButton/ChatGptUsageButton",
  PluginOriginalChatGptUsageButton,
);

function PluginOriginalChatGptUsageButton(props: Omit<ComponentProps<typeof Button>, "onClick">) {
  return (
    <Button
      variant="ghost-muted"
      size="sm"
      {...props}
      onClick={() => void ensureLocalApi().shell.openExternal(CHATGPT_USAGE_URL)}
    >
      <T>Manage usage</T>
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
