import { describe, expect, it } from "vite-plus/test";

import { composerSettingsToolbarLayout } from "./composer-draft-expansion";

describe("composer settings toolbar layout", () => {
  it("never overlays the native editor", () => {
    expect(
      composerSettingsToolbarLayout({ isExpanded: false, isVoicePresented: false }).overlayEditor,
    ).toBe(false);
    expect(
      composerSettingsToolbarLayout({ isExpanded: true, isVoicePresented: false }).overlayEditor,
    ).toBe(false);
    expect(
      composerSettingsToolbarLayout({ isExpanded: false, isVoicePresented: true }).overlayEditor,
    ).toBe(false);
  });

  it("mounts the row only when the draft is expanded or dictation is showing", () => {
    expect(
      composerSettingsToolbarLayout({ isExpanded: false, isVoicePresented: false }).mount,
    ).toBe(false);
    expect(
      composerSettingsToolbarLayout({ isExpanded: true, isVoicePresented: false }).mount,
    ).toBe(true);
    expect(
      composerSettingsToolbarLayout({ isExpanded: false, isVoicePresented: true }).mount,
    ).toBe(true);
  });
});
