const MODEL_PICKER_CONTENT_SELECTOR = "[data-model-picker-content]";

export function isModelPickerOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(MODEL_PICKER_CONTENT_SELECTOR) !== null
  );
}
