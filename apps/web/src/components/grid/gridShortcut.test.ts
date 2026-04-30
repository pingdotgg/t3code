import { describe, expect, it } from "vitest";

import { gridSplitViewShortcutLabel, isGridSplitViewShortcut } from "./gridShortcut";

function keyDown(overrides: Partial<KeyboardEvent>) {
  return {
    type: "keydown",
    key: "g",
    code: "KeyG",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("isGridSplitViewShortcut", () => {
  it("matches Ctrl+Shift+G on non-mac", () => {
    const event = keyDown({ ctrlKey: true, shiftKey: true });
    expect(isGridSplitViewShortcut(event, "Win32")).toBe(true);
  });

  it("matches Cmd+Shift+G on mac", () => {
    const event = keyDown({ metaKey: true, shiftKey: true });
    expect(isGridSplitViewShortcut(event, "MacIntel")).toBe(true);
  });

  it("does not match without shift", () => {
    const event = keyDown({ ctrlKey: true });
    expect(isGridSplitViewShortcut(event, "Win32")).toBe(false);
  });

  it("does not match alt modifier", () => {
    const event = keyDown({ ctrlKey: true, shiftKey: true, altKey: true });
    expect(isGridSplitViewShortcut(event, "Win32")).toBe(false);
  });

  it("does not match cross-platform modifier", () => {
    const event = keyDown({ metaKey: true, shiftKey: true });
    expect(isGridSplitViewShortcut(event, "Win32")).toBe(false);
    const event2 = keyDown({ ctrlKey: true, shiftKey: true });
    expect(isGridSplitViewShortcut(event2, "MacIntel")).toBe(false);
  });

  it("ignores non-keydown event types", () => {
    const event = keyDown({ type: "keyup", ctrlKey: true, shiftKey: true });
    expect(isGridSplitViewShortcut(event, "Win32")).toBe(false);
  });
});

describe("gridSplitViewShortcutLabel", () => {
  it("returns mac symbols on mac", () => {
    const label = gridSplitViewShortcutLabel("MacIntel");
    expect(label).toContain("\u2318");
    expect(label).toContain("\u21e7");
  });

  it("returns text label on non-mac", () => {
    expect(gridSplitViewShortcutLabel("Win32")).toBe("Ctrl+Shift+G");
  });
});
