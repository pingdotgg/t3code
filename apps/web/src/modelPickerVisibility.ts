const MODEL_PICKER_CONTENT_SELECTOR = "[data-model-picker-content]";

/**
 * Model-picker visibility is already represented by the mounted popover.
 * Shortcut arbitration reads that source directly instead of mirroring it in
 * a second React or external store.
 */
export function isModelPickerOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(MODEL_PICKER_CONTENT_SELECTOR) !== null
  );
}
