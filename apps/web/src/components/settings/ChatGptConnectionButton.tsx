import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? "Continue with ChatGPT"}
    </Button>
  );
}
