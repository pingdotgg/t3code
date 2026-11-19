import * as Dialog from "../../components/ui/Dialog";
import { buildNewThreadLink, type LinkedPrompt } from "@t3tools/shared/promptLinks";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { resolveHostedAppUrl } from "../cloud/publicConfig";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

export function showPromptLinkNotice(notice: string): void {
  Dialog.alert(m(msg("Prompt from a link")), notice);
}

export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert(
      m(msg("Could not open link")),
      m(msg("Drafts could not be loaded, so the prompt was not added.")),
    );
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Dialog.alert(m(msg("Linked prompt ready. Replace draft?")), notice, [
    { text: m(msg("Keep mine")), style: "cancel" },
    {
      text: m(msg("Replace", { $context: "verb, replaces the draft" })),
      onPress: () => setComposerDraftText(draftKey, prompt.text),
    },
  ]);
}

export async function copyPromptLink(prompt: string): Promise<void> {
  const link = buildNewThreadLink({ prompt, origin: resolveHostedAppUrl() ?? undefined });
  if (!(await tryCopyTextWithHaptic(link, { target: "prompt link" }))) {
    Dialog.alert(m(msg("Could not copy")), m(msg("Try again.")));
  }
}
