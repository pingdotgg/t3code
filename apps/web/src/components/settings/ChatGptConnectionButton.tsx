import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const { t } = useTranslation("settings");
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? t("chatGpt.continueWith")}
    </Button>
  );
}
