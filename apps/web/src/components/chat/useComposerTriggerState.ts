import { useRef, useState } from "react";

import { continueComposerPathTrigger } from "@t3tools/shared/composerTrigger";
import { detectComposerTrigger, type ComposerTrigger } from "../../composer-logic";

export function useComposerTriggerState(initialText: string, initialEnabled = true) {
  const [trigger, setActiveTrigger] = useState(() =>
    initialEnabled ? detectComposerTrigger(initialText, initialText.length) : null,
  );
  const previousSearchRef = useRef({
    text: initialText,
    trigger,
    queryEnd: trigger?.rangeEnd ?? 0,
  });
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);

  const detectTrigger = (text: string, cursor: number) => {
    const previous = previousSearchRef.current;
    const continued = continueComposerPathTrigger(
      text,
      cursor,
      previous.trigger,
      previous.text,
      previous.queryEnd,
    );
    const candidate = detectComposerTrigger(text, cursor) ?? continued?.trigger ?? null;
    const queryEnd =
      candidate?.kind === "path" && candidate.rangeStart === continued?.trigger.rangeStart
        ? continued.queryEnd
        : (candidate?.rangeEnd ?? 0);
    previousSearchRef.current = { text, trigger: candidate, queryEnd };
    return candidate;
  };

  const clearPathTriggerForSelection = () => {
    previousSearchRef.current = { text: "", trigger: null, queryEnd: 0 };
    setActiveTrigger((current) => (current?.kind === "path" ? null : current));
  };

  const resolveTrigger = (candidate: ComposerTrigger | null, hasSelection = false) => {
    if (hasSelection && candidate?.kind === "path") {
      clearPathTriggerForSelection();
      return null;
    }
    const dismissed = dismissedTriggerRef.current;
    return candidate &&
      dismissed &&
      candidate.kind === dismissed.kind &&
      candidate.rangeStart === dismissed.rangeStart
      ? null
      : candidate;
  };

  const setTrigger = (candidate: ComposerTrigger | null, text?: string, hasSelection = false) => {
    if (hasSelection && (candidate === null || candidate.kind === "path")) {
      previousSearchRef.current = { text: "", trigger: null, queryEnd: 0 };
      setActiveTrigger(null);
      return;
    }
    if (text !== undefined || candidate === null) {
      previousSearchRef.current = {
        text: text ?? "",
        trigger: candidate,
        queryEnd: candidate?.rangeEnd ?? 0,
      };
    }
    const activeTrigger = resolveTrigger(candidate);
    if (candidate === null || activeTrigger !== null) {
      dismissedTriggerRef.current = null;
    }
    setActiveTrigger(activeTrigger);
  };

  const dismissTrigger = (candidate: ComposerTrigger | null) => {
    dismissedTriggerRef.current = candidate;
    setActiveTrigger(null);
  };

  const resetTrigger = (candidate: ComposerTrigger | null, text: string) => {
    previousSearchRef.current = { text, trigger: candidate, queryEnd: candidate?.rangeEnd ?? 0 };
    dismissedTriggerRef.current = null;
    setActiveTrigger(candidate);
  };

  return {
    trigger,
    detectTrigger,
    setTrigger,
    resolveTrigger,
    dismissTrigger,
    resetTrigger,
    clearPathTriggerForSelection,
  };
}
