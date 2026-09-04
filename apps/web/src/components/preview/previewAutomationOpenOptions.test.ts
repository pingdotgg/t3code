import { resolveBrowserProfiles } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { BrowserDefaults } from "~/browser/browserDefaults";

import {
  PreviewAutomationProfileNotFoundError,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";
import { previewAutomationOpenOptions } from "./previewAutomationOpenOptions";

const defaults: BrowserDefaults = {
  viewport: { _tag: "freeform", width: 1280, height: 800 },
  zoomFactor: 1,
  appearance: "system",
  autoShowFloatingPreview: true,
  profiles: resolveBrowserProfiles([
    { id: "profile-feature-a", name: "Feature A", kind: "persistent" },
  ]),
  profileId: "profile-feature-a",
};

describe("previewAutomationOpenOptions", () => {
  it.each(["default", "incognito", "profile-feature-a"])(
    "opens in the explicitly requested %s profile",
    (profileId) => {
      expect(previewAutomationOpenOptions({ profileId }, defaults)).toEqual({
        viewport: defaults.viewport,
        profileId,
      });
    },
  );

  it("preserves existing behavior when no profile was requested", () => {
    expect(previewAutomationOpenOptions({}, defaults)).toEqual({ viewport: defaults.viewport });
  });

  it("rejects an unknown or deleted profile rather than falling back to another login", () => {
    expect(() => previewAutomationOpenOptions({ profileId: "profile-deleted" }, defaults)).toThrow(
      PreviewAutomationProfileNotFoundError,
    );
  });

  it("returns a useful profile error through the automation error protocol", () => {
    const error = new PreviewAutomationProfileNotFoundError({ profileId: "profile-deleted" });
    expect(serializePreviewAutomationHostError(error)).toEqual({
      _tag: "PreviewAutomationExecutionError",
      message: error.message,
      detail: { profileId: "profile-deleted" },
    });
  });
});
