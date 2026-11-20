import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { msg } from "gt-react";
import { TypeIcon } from "lucide-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { getComposerPromptInputLength } from "./composerSubmission";

/** A tray notice for over-limit prompts; sending stays blocked until the prompt fits. */
export function composerPromptLengthBannerItem(
  {
    message,
    prompt,
    onStash,
    onDismiss,
  }: {
    message: string | null;
    prompt: string;
    onStash: () => void;
    onDismiss: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem | null {
  if (!message) return null;
  const inputLength = getComposerPromptInputLength(prompt);
  // The expanded provider input can overflow while the typed prompt fits, so
  // fall back to the full message when the counts would not explain it.
  const description =
    inputLength > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ? resolve(
          msg("{count} / {max} characters", {
            count: inputLength.toLocaleString("en-US"),
            max: PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US"),
          }),
        )
      : message;
  return {
    id: "prompt-length",
    variant: "error",
    icon: <TypeIcon />,
    title: resolve(msg("Prompt too long")),
    description,
    actions: (
      <Button size="xs" variant="secondary" onClick={onStash}>
        {resolve(msg("Stash prompt"))}
      </Button>
    ),
    dismissLabel: resolve(msg("Dismiss prompt length warning")),
    onDismiss,
  };
}
