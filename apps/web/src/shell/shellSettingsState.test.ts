import { describe, expect, it } from "vite-plus/test";

import { buildShellSettingsState, resolveActiveSettingsSection } from "./shellSettingsState";

describe("buildShellSettingsState", () => {
  it("is inactive off the settings routes and lists every section", () => {
    const state = buildShellSettingsState({ pathname: "/env/thread", searchQuery: "" });
    expect(state.active).toBe(false);
    expect(state.activeSection).toBeNull();
    expect(state.sections.map((section) => section.to)).toContain("/settings/general");
    expect(state.searchResults).toEqual([]);
  });

  it("marks the active section and resolves search results with their section label", () => {
    const state = buildShellSettingsState({
      pathname: "/settings/keybindings",
      searchQuery: "theme",
    });
    expect(state.active).toBe(true);
    expect(state.activeSection).toBe("/settings/keybindings");
    expect(state.searchResults.length).toBeGreaterThan(0);
    for (const result of state.searchResults) {
      expect(result.sectionLabel.length).toBeGreaterThan(0);
      expect(result.to.startsWith("/settings/")).toBe(true);
    }
  });

  it("resolves nested settings paths to their section", () => {
    expect(resolveActiveSettingsSection("/settings/providers/codex")).toBe("/settings/providers");
    expect(resolveActiveSettingsSection("/settings")).toBeNull();
  });
});
