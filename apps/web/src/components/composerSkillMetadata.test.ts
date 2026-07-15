import { describe, expect, it } from "vite-plus/test";
import { resolveComposerSkillMetadata } from "./composerSkillMetadata";

describe("resolveComposerSkillMetadata", () => {
  it("clears stale presentation when a skill is absent from refreshed metadata", () => {
    const refreshedMetadata = new Map([
      ["other-skill", { label: "Other Skill", description: "Still available" }],
    ]);

    expect(resolveComposerSkillMetadata("removed-skill", refreshedMetadata)).toEqual({
      label: "removed-skill",
      description: null,
    });
  });
});
