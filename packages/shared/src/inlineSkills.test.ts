import { describe, expect, it } from "vite-plus/test";
import { formatProviderSkillDisplayName } from "./inlineSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it.each([
    ["mca_lab_status", "mca_lab_status"],
    ["frontend-design:frontend-design", "frontend-design:frontend-design"],
    ["superpowers:brainstorming", "superpowers:brainstorming"],
    ["DesignSync", "DesignSync"],
  ])("shows %s as its skill name when the provider sets no display name", (name, label) => {
    expect(formatProviderSkillDisplayName({ name })).toBe(label);
  });

  it("prefers the provider display name", () => {
    expect(formatProviderSkillDisplayName({ name: "gh-fix-ci", displayName: " Fix CI " })).toBe(
      "Fix CI",
    );
  });
});
