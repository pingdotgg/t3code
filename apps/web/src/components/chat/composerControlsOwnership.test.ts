import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  matchesDefault: true,
  planModeUiEnabled: false,
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  it("hides the chip at the default and lets the model picker answer composer.mode", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "hidden",
      showModeBlock: false,
      hiddenBlockIds: [],
      pickerOwnsModeShortcut: true,
    });
  });

  it("shows a labelled chip that owns composer.mode when the mode differs", () => {
    const result = resolveComposerControlsOwnership({ ...base, matchesDefault: false });
    expect(result).toMatchObject({
      accessDisplay: "label",
      showModeBlock: true,
      pickerOwnsModeShortcut: false,
    });
  });

  it("gives an overflowed chip's Permissions to the overflow menu when it has no Plan toggle", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });

  it("keeps the Plan toggle block at the default and leaves Permissions with the picker", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.showModeBlock).toBe(true);
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.pickerOwnsModeShortcut).toBe(true);
  });

  it("overflows only the chip when the Plan toggle gives the overflow menu content", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      matchesDefault: false,
      planModeUiEnabled: true,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    // Permissions stay in the model picker, which now answers composer.mode.
    expect(result.overflowShowsPermissions).toBe(false);
    expect(result.pickerOwnsModeShortcut).toBe(true);
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
