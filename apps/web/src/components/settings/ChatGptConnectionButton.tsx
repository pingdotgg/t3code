import { useGT } from "gt-react";
import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { definePluginComponent } from "~/plugins/features";

export const ChatGptConnectionButton = definePluginComponent(
  "component:components/settings/ChatGptConnectionButton/ChatGptConnectionButton",
  PluginOriginalChatGptConnectionButton,
);

function PluginOriginalChatGptConnectionButton({
  children,
  ...props
}: ComponentProps<typeof Button>) {
  const gt = useGT();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? gt("Continue with ChatGPT")}
    </Button>
  );
}
