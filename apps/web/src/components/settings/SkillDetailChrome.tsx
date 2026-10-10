import { useEffect, useEffectEvent } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";

/**
 * Escape goes from an open skill or instruction file back to the list. Settings leaves the page
 * on Escape from its own window listener, so this one runs first, in the capture phase, and keeps
 * Escape from reaching it. Escape inside a field, dialog or menu belongs to that control.
 */
export function useEscapeToList(onBack: () => void) {
  const goBack = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing)
      return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input,textarea,select,[contenteditable],[role="dialog"],[role="alertdialog"],[role="menu"]',
      )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onBack();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => goBack(event);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}

/** Copies a path to the clipboard and says so in a toast. */
export function copyPath(path: string, what: string) {
  void writeTextToClipboard(path, what).then(
    (didCopy) => {
      if (didCopy) toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  );
}
