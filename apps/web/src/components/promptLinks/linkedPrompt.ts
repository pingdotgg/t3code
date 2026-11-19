import type { LinkedPrompt } from "@t3tools/shared/promptLinks";
import { msg } from "gt-react";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { m } from "~/i18n/messages";

import { toastManager } from "../ui/toast";
import { APP_NAME } from "@t3tools/shared/branding";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: "This prompt had hidden characters, it may be malicious",
    description: `${APP_NAME} removed ${prompt.hiddenCharacters} hidden character${prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.`,
    timeout: 0,
  });
}

export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt,
  notes: ReadonlyArray<string> = [],
): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    useComposerDraftStore.getState().setPrompt(target, prompt.text);
    toastManager.add({
      type: "info",
      title: m(msg("Prompt added from a link")),
      description: [m(msg("Read it before you send.")), ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: m(msg("Linked prompt ready")),
    description: m(msg("This thread already has a draft. Replace it with the linked prompt?")),
    timeout: 0,
    actionProps: {
      children: m(msg("Replace draft")),
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
