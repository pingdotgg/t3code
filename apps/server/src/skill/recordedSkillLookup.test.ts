import { describe, expect, it } from "vite-plus/test";

import { lookupRecordedSkill } from "./recordedSkillLookup.ts";

const review = { name: "review", path: "/tmp/skills/review/SKILL.md" };

describe("lookupRecordedSkill", () => {
  it("treats omitted resolvedSkills as a legacy message", () => {
    expect(lookupRecordedSkill(undefined, "review")).toEqual({ kind: "legacy" });
  });

  it("returns the recorded path when the name was frozen at submit time", () => {
    expect(lookupRecordedSkill([review], "review")).toEqual({
      kind: "recorded",
      skill: review,
    });
  });

  it("does not live-resolve a name missing from a frozen list", () => {
    expect(lookupRecordedSkill([], "review")).toEqual({
      kind: "recorded",
      skill: undefined,
    });
    expect(lookupRecordedSkill([review], "implementor")).toEqual({
      kind: "recorded",
      skill: undefined,
    });
  });
});
