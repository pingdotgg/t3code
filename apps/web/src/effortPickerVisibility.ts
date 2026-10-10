const EFFORT_PICKER_CONTENT_SELECTOR = "[data-effort-picker-content]";

/**
 * Like `isModelPickerOpen`, reads the mounted effort options directly so
 * thread shortcuts can yield `mod+1..9` while the effort menu is open.
 */
export function isEffortPickerOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(EFFORT_PICKER_CONTENT_SELECTOR) !== null
  );
}
