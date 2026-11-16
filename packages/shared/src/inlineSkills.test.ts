import { describe, expect, it } from "vite-plus/test";
import { formatProviderSkillDisplayName, matchInlineSkills } from "./inlineSkills.ts";

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

describe("matchInlineSkills", () => {
  it("preserves offsets, skill identity, first-name precedence, and unknown tokens", () => {
    const first = { name: "design", displayName: "Design" };
    const duplicate = { name: "design", displayName: "Other design" };
    const namespaced = { name: "pdf:pdf" };
    const matches = [
      ...matchInlineSkills("Use $design then $missing and $pdf:pdf, $pdf:pdf $design", [
        first,
        duplicate,
        namespaced,
      ]),
    ];
    expect(matches).toEqual([
      { start: 4, end: 11, skill: first, rawText: "$design" },
      { start: 40, end: 48, skill: namespaced, rawText: "$pdf:pdf" },
      { start: 49, end: 56, skill: first, rawText: "$design" },
    ]);
    expect(matches[0]?.skill).toBe(first);
    expect(matches[1]?.skill).toBe(namespaced);
    expect(matches[2]?.skill).toBe(first);
  });
});
