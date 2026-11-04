import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { TypeIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { getComposerPromptInputLength } from "./composerSubmission";

/** A tray notice for over-limit prompts; sending stays blocked until the prompt fits. */
export function composerPromptLengthBannerItem({
  message,
  prompt,
  onStash,
  onDismiss,
}: {
  message: string | null;
  prompt: string;
  onStash: () => void;
  onDismiss: () => void;
}): ComposerBannerStackItem | null {
  if (!message) return null;
  const inputLength = getComposerPromptInputLength(prompt);
  // The expanded provider input can overflow while the typed prompt fits, so
  // fall back to the full message when the counts would not explain it.
  const description =
    inputLength > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ? `${inputLength.toLocaleString("en-US")} / ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} characters`
      : message;
  return {
    id: "prompt-length",
    variant: "error",
    icon: <TypeIcon />,
    title: "Prompt too long",
    description,
    actions: (
      <Button size="xs" variant="secondary" onClick={onStash}>
        Stash prompt
      </Button>
    ),
    dismissLabel: "Dismiss prompt length warning",
    onDismiss,
  };
}
