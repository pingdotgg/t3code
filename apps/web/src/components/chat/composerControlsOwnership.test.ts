import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  matchesDefault: true,
  hasTraits: true,
  planModeUiEnabled: false,
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  it("hides the chip at the default and lets the effort menu answer composer.mode", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      effortOwnsModeShortcut: true,
    });
  });

  it("shows a labelled chip that owns composer.mode when the mode differs", () => {
    const result = resolveComposerControlsOwnership({ ...base, matchesDefault: false });
    expect(result).toMatchObject({
      accessDisplay: "label",
      showModeBlock: true,
      effortOwnsModeShortcut: false,
    });
  });

  it("never leaves an empty overflow menu: the effort chip overflows with the chip", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["traits", "mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
    // One composer.mode target: the overflow menu, not the overflowed effort chip.
    expect(result.effortOwnsModeShortcut).toBe(false);
  });

  it("keeps the Plan toggle block at the default and overflows it before the effort chip", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.showModeBlock).toBe(true);
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.effortOwnsModeShortcut).toBe(true);
  });

  it("overflows only the chip when the Plan toggle gives the overflow menu content", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    // Permissions stay in the visible effort menu, which now answers composer.mode.
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.effortOwnsModeShortcut).toBe(true);
  });

  it("keeps a permissions icon for models without traits, even at the default", () => {
    const result = resolveComposerControlsOwnership({ ...base, hasTraits: false });
    expect(result.accessDisplay).toBe("icon");
    const overflowed = resolveComposerControlsOwnership({
      ...base,
      hasTraits: false,
      measuredHiddenBlockCount: 1,
    });
    expect(overflowed.hiddenBlockIds).toEqual(["mode"]);
    expect(overflowed.overflowShowsPermissions).toBe(true);
  });

  it("shows the non-default chip as an icon in the compacted row", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      collapsed: true,
    });
    expect(result.accessDisplay).toBe("icon");
  });
});
