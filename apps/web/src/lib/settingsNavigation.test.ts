import { describe, expect, it } from "vitest";

import { canNavigateBackInApp, shouldCloseSettingsOnEscape } from "./settingsNavigation";

describe("shouldCloseSettingsOnEscape", () => {
  it("matches plain Escape", () => {
    expect(shouldCloseSettingsOnEscape({ key: "Escape" })).toBe(true);
  });

  it("ignores modified Escape shortcuts", () => {
    expect(shouldCloseSettingsOnEscape({ key: "Escape", metaKey: true })).toBe(false);
    expect(shouldCloseSettingsOnEscape({ key: "Escape", ctrlKey: true })).toBe(false);
    expect(shouldCloseSettingsOnEscape({ key: "Escape", altKey: true })).toBe(false);
    expect(shouldCloseSettingsOnEscape({ key: "Escape", shiftKey: true })).toBe(false);
  });

  it("ignores prevented and non-Escape events", () => {
    expect(shouldCloseSettingsOnEscape({ key: "Escape", defaultPrevented: true })).toBe(false);
    expect(shouldCloseSettingsOnEscape({ key: "Enter" })).toBe(false);
  });
});

describe("canNavigateBackInApp", () => {
  it("returns true when tanstack router history has a previous entry", () => {
    expect(canNavigateBackInApp({ __TSR_index: 1 })).toBe(true);
    expect(canNavigateBackInApp({ __TSR_index: 4 })).toBe(true);
  });

  it("returns false for empty or external history state", () => {
    expect(canNavigateBackInApp(null)).toBe(false);
    expect(canNavigateBackInApp({})).toBe(false);
    expect(canNavigateBackInApp({ __TSR_index: 0 })).toBe(false);
    expect(canNavigateBackInApp({ __TSR_index: "1" })).toBe(false);
  });
});
