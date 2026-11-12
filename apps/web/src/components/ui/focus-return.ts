import type { Dialog } from "@base-ui/react/dialog";

type FinalFocusHandler = Extract<Dialog.Popup.Props["finalFocus"], (...args: never[]) => unknown>;

const returningFocus = new WeakSet<Document>();

export function prepareFocusReturn(document: Document) {
  returningFocus.add(document);
  queueMicrotask(() => queueMicrotask(() => returningFocus.delete(document)));
}

export function isReturningFocus(document: Document) {
  return returningFocus.has(document);
}

export function tooltipSafeFinalFocus(
  finalFocus: Dialog.Popup.Props["finalFocus"],
  popupId: string,
): FinalFocusHandler {
  const handleFinalFocus: FinalFocusHandler = (closeType) => {
    const popup = document.getElementById(popupId);
    const focusContainer = popup?.closest("[data-base-ui-portal]") ?? popup;
    const activeElement = document.activeElement;
    if (
      (finalFocus === undefined || typeof finalFocus === "boolean") &&
      activeElement !== document.body &&
      !focusContainer?.contains(activeElement)
    ) {
      return false;
    }
    prepareFocusReturn(document);
    if (typeof finalFocus === "function") return finalFocus(closeType);
    return typeof finalFocus === "object" ? finalFocus.current : (finalFocus ?? true);
  };
  return handleFinalFocus;
}
