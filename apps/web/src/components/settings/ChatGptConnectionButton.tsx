import type { ComponentProps } from "react";
import { useT } from "../../hooks/useI18n";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const t = useT();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? t("settings.providers.chatgpt.continue")}
    </Button>
  );
}
