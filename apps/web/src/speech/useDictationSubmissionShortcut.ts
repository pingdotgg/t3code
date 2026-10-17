import { useEffect, useRef, type RefObject } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";

/** Keep submission shortcuts reachable when the frozen composer loses focus to the page. */
export function useDictationSubmissionShortcut(input: {
  enabled: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  onKeyDown(event: KeyboardEvent): void;
}) {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  useEffect(() => {
    if (!input.enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target !== document.body && target !== document.documentElement) {
        if (!latest.current.formRef.current?.contains(target)) return;
        if (!target.closest('[data-testid="composer-editor"]')) return;
        if (target.closest("textarea, input, button")) return;
      }
      latest.current.onKeyDown(event);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [input.enabled]);
}
