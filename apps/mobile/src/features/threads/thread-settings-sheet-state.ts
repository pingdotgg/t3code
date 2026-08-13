import type { ProviderOptionDescriptor } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import { selectableChoices } from "./thread-settings-menu";

/** Compact chip rows stay scannable; longer catalogs keep a disclosure. */
export const INLINE_SELECT_CHOICE_LIMIT = 6;

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/**
 * Settings the displayed model actually advertises. Unsupported rows stay
 * out of the sheet instead of rendering disabled — switching models should
 * only show controls that can change something.
 */
export function visibleSheetOptionDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.filter((descriptor) => {
    if (descriptor.type === "boolean") {
      return true;
    }
    return selectableChoices(descriptor).length > 0;
  });
}

export function usesInlineSelectChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
): boolean {
  return selectableChoices(descriptor).length <= INLINE_SELECT_CHOICE_LIMIT;
}
