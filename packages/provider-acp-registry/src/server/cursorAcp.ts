import type { ModelSelection } from "@t3tools/contracts";

// Without this, Cursor offers one preset per model with the effort baked into its id.
export const cursorClientCapabilitiesMeta = { parameterizedModelPicker: true };

const CURSOR_PRESET_MODEL = /^([^[\]]+)\[([^[\]]*)\]$/;

/** Saved selections can hold a preset id such as `composer-2[fast=true]` from before the flag. */
export function normalizeCursorModelSelection(selection: ModelSelection): ModelSelection {
  const match = CURSOR_PRESET_MODEL.exec(selection.model);
  const model = match?.[1];
  const parameters = match?.[2];
  if (model === undefined || parameters === undefined) return selection;
  const options = selection.options ?? [];
  const presetOptions = parameters.split(",").flatMap((parameter) => {
    const separator = Math.max(parameter.indexOf("="), 0);
    const id = parameter.slice(0, separator).trim();
    const value = parameter.slice(separator + 1).trim();
    if (id.length === 0 || value.length === 0 || options.some((option) => option.id === id)) {
      return [];
    }
    return [{ id, value }];
  });
  return { ...selection, model, options: [...options, ...presetOptions] };
}
