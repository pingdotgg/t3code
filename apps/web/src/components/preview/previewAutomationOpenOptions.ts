import { findBrowserProfile, type PreviewAutomationOpenInput } from "@t3tools/contracts";

import type { BrowserDefaults } from "~/browser/browserDefaults";

import { PreviewAutomationProfileNotFoundError } from "./previewAutomationErrors";

export function previewAutomationOpenOptions(
  input: PreviewAutomationOpenInput,
  defaults: BrowserDefaults,
) {
  if (input.profileId !== undefined && !findBrowserProfile(defaults.profiles, input.profileId)) {
    throw new PreviewAutomationProfileNotFoundError({ profileId: input.profileId });
  }
  return {
    viewport: defaults.viewport,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  };
}
