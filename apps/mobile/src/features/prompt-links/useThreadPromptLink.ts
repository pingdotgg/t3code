import * as Dialog from "../../components/Dialog";
import { useNavigation } from "@react-navigation/native";
import { parseThreadLinkPrompt } from "@t3tools/shared/promptLinks";
import { useEffect, useRef } from "react";

import { applyLinkedPromptToThreadDraft } from "./prompt-link-actions";
import {
  clearedPromptLinkParams,
  promptLinkNotice,
  promptLinkSearchFromParams,
} from "./prompt-link-model";

const THREAD_LINK_KEYS = ["prompt"];

/**
 * Applies the `prompt` of a `t3code://threads/<environmentId>/<threadId>?prompt=…` link to that
 * thread's composer draft, once per link. Used by `ThreadRouteScreen`.
 */
export function useThreadPromptLink(
  params: Readonly<Record<string, unknown>> | undefined,
  threadDraftKey: string | null,
) {
  const navigation = useNavigation();
  const search = promptLinkSearchFromParams(params, THREAD_LINK_KEYS);
  const handledSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (search === null) {
      handledSearchRef.current = null;
      return;
    }
    if (threadDraftKey === null || handledSearchRef.current === search) return;
    handledSearchRef.current = search;
    navigation.setParams(clearedPromptLinkParams(THREAD_LINK_KEYS));
    const parsed = parseThreadLinkPrompt(search);
    if (!parsed.ok) {
      Dialog.alert("Could not open link", parsed.error);
      return;
    }
    if (parsed.value === null) return;
    void applyLinkedPromptToThreadDraft(
      threadDraftKey,
      parsed.value,
      promptLinkNotice({ hiddenCharacters: parsed.value.hiddenCharacters }),
    );
  }, [navigation, search, threadDraftKey]);
}
