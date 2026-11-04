import { useEffect, useEffectEvent, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore, composerDraftHasUserContent } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadEnvironment } from "~/state/threads";
import { toastManager } from "../ui/toastManager";
import { Button } from "../ui/button";

const dismissedThreadKeys = new Set<string>();

export function ThreadSplitSuggestion({
  threadRef,
  projectId,
  idle,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  idle: boolean;
}) {
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const allowed = useAtomValue(
    threadEnvironment.suggestSplit.permissionAtom(threadRef.environmentId),
  );
  const prompt = useComposerDraftStore((store) => store.getComposerDraft(threadRef)?.prompt ?? "");
  const hasContext = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(threadRef);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
  const suggest = useAtomCommand(threadEnvironment.suggestSplit, {
    reportFailure: false,
    reportDefect: false,
  });
  const newThread = useNewThreadHandler();
  const [suggestedKey, setSuggestedKey] = useState<string | null>(null);
  const threadKey = scopedThreadKey(threadRef);
  const [dismissed, setDismissed] = useState(() => dismissedThreadKeys.has(threadKey));
  const [opening, setOpening] = useState(false);
  const enabled =
    settings.threadSplitSuggestionsEnabled &&
    Boolean(settings.threadSplitModelEndpoint) &&
    allowed &&
    idle &&
    !hasContext &&
    Boolean(prompt.trim());
  const requestKey = JSON.stringify([
    threadRef.environmentId,
    threadRef.threadId,
    settings.threadSplitModelEndpoint,
    prompt,
  ]);
  const selectionKey = JSON.stringify([enabled, requestKey]);
  const [observedKey, setObservedKey] = useState(selectionKey);
  if (observedKey !== selectionKey) {
    setObservedKey(selectionKey);
    setSuggestedKey(null);
  }
  if (dismissed && !prompt.trim()) {
    dismissedThreadKeys.delete(threadKey);
    setDismissed(false);
  }
  const check = useEffectEvent(async (message: string, key: string, cancelled: () => boolean) => {
    const result = await suggest({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, message },
    });
    if (!cancelled())
      setSuggestedKey(AsyncResult.isSuccess(result) && result.value.suggest ? key : null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces remote inference and ignores replies after the draft or destination changes
  useEffect(() => {
    if (!enabled || dismissed) return;
    let cancelled = false;
    const timer = setTimeout(() => void check(prompt, requestKey, () => cancelled), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, requestKey, prompt, dismissed]);

  if (!enabled || dismissed || suggestedKey !== requestKey) return null;
  const open = async () => {
    const current = useComposerDraftStore.getState().getComposerDraft(threadRef);
    if (
      !current ||
      current.prompt !== prompt ||
      composerDraftHasUserContent({ ...current, prompt: "" })
    )
      return;
    setOpening(true);
    try {
      const target = await newThread(scopeProjectRef(threadRef.environmentId, projectId), {
        prompt,
      });
      const store = useComposerDraftStore.getState();
      const source = store.getComposerDraft(threadRef);
      if (
        target &&
        source &&
        !composerDraftHasUserContent({ ...source, prompt: "" }) &&
        store.getComposerDraft(target.draftId)?.prompt === prompt &&
        store.getComposerDraft(threadRef)?.prompt === prompt
      )
        store.setPrompt(threadRef, "");
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open a new thread",
        description: "Your draft is still in this thread.",
      });
    }
    setOpening(false);
  };
  return (
    <div className="flex items-center justify-end gap-2 py-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={opening}
        onClick={() => void open()}
      >
        Start a new thread with this draft
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          dismissedThreadKeys.add(threadKey);
          setDismissed(true);
        }}
        aria-label="Dismiss new thread suggestion"
      >
        Dismiss
      </Button>
    </div>
  );
}
