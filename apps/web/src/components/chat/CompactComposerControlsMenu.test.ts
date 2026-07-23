import { describe, expect, it } from "vite-plus/test";

import { compactComposerShortcutHintLabel } from "./CompactComposerControlsMenu";

describe("compactComposerShortcutHintLabel", () => {
  it("keeps every available compact-control hint visible", () => {
    expect(
      compactComposerShortcutHintLabel({
        modelOptions: "⌘O",
        modelOptionsAvailable: true,
        runtimeMode: "⌘R",
        runtimeModeAvailable: true,
        planMode: "⌘P",
        planModeAvailable: true,
      }),
    ).toBe("Options ⌘O · Access ⌘R · Plan ⌘P");
  });

  it("omits unavailable controls and hides an empty hint", () => {
    expect(
      compactComposerShortcutHintLabel({
        modelOptions: null,
        modelOptionsAvailable: true,
        runtimeMode: "⌘R",
        runtimeModeAvailable: true,
        planMode: null,
        planModeAvailable: true,
      }),
    ).toBe("Access ⌘R");
    expect(
      compactComposerShortcutHintLabel({
        modelOptions: null,
        modelOptionsAvailable: true,
        runtimeMode: null,
        runtimeModeAvailable: true,
        planMode: null,
        planModeAvailable: true,
      }),
    ).toBeNull();
  });

  it("omits labels whose corresponding action is unavailable", () => {
    expect(
      compactComposerShortcutHintLabel({
        modelOptions: "⌘O",
        modelOptionsAvailable: false,
        runtimeMode: "⌘R",
        runtimeModeAvailable: true,
        planMode: "⌘P",
        planModeAvailable: false,
      }),
    ).toBe("Access ⌘R");
  });
});
