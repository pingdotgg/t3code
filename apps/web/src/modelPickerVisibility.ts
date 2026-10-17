import { queryShownElement } from "./lib/shownElement";

const MODEL_PICKER_CONTENT_SELECTOR = "[data-model-picker-content]";

export function isModelPickerOpen(): boolean {
  return queryShownElement(MODEL_PICKER_CONTENT_SELECTOR) !== null;
}
