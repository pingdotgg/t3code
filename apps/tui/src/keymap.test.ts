import { describe, expect, it } from "bun:test";

import { KEYBINDING_GROUPS } from "./keymap.ts";

describe("keymap reference", () => {
  it("documents non-empty groups, each with described bindings", () => {
    expect(KEYBINDING_GROUPS.length).toBeGreaterThan(0);
    for (const group of KEYBINDING_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.bindings.length).toBeGreaterThan(0);
      for (const binding of group.bindings) {
        expect(binding.keys.length).toBeGreaterThan(0);
        expect(binding.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers the headline shortcuts", () => {
    const all = KEYBINDING_GROUPS.flatMap((g) => g.bindings);
    expect(all.some((b) => b.keys === "^K")).toBe(true);
    expect(all.some((b) => b.description.includes("plan / build"))).toBe(true);
  });
});
