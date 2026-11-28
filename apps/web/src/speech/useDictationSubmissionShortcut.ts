import { useEffect, useRef, type RefObject } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { shouldRedirectInputToComposer } from "../components/chat/composerFocusRedirect";

function isFrozenComposerTarget(target: Element, form: HTMLFormElement | null) {
  return (
    !!form?.contains(target) &&
    !!target.closest('[data-testid="composer-editor"]') &&
    !target.closest("textarea, input, button")
  );
}

/** Keep submission shortcuts reachable when the frozen composer loses focus to the page. */
export function useDictationSubmissionShortcut(input: {
  enabled: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  onKeyDown(event: KeyboardEvent): void;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed inputs to the window keydown listener
  useEffect(() => {
    latest.current = input;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown while dictation owns submission
  useEffect(() => {
    if (!input.enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target !== document.body &&
        target !== document.documentElement &&
        !isFrozenComposerTarget(target, latest.current.formRef.current) &&
        // Focus parked on the chat itself, such as the timeline, belongs to the composer.
        !shouldRedirectInputToComposer(event)
      )
        return;
      latest.current.onKeyDown(event);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [input.enabled]);
}
