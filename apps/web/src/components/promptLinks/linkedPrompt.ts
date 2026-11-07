import type { LinkedPrompt } from "@t3tools/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";
import { translateNow } from "../../lib/miscTranslateNow";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: translateNow("misc.promptLinks.hiddenTitle"),
    description: translateNow(
      prompt.hiddenCharacters === 1
        ? "misc.promptLinks.hiddenDescription.one"
        : "misc.promptLinks.hiddenDescription.other",
      { count: prompt.hiddenCharacters },
    ),
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
      title: translateNow("misc.promptLinks.added"),
      description: notes.reduce(
        (text, note) => translateNow("misc.promptLinks.notesJoin", { a: text, b: note }),
        translateNow("misc.promptLinks.readBeforeSend"),
      ),
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: translateNow("misc.promptLinks.ready"),
    description: translateNow("misc.promptLinks.replaceQuestion"),
    timeout: 0,
    actionProps: {
      children: translateNow("misc.promptLinks.replaceDraft"),
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
