import { describe, expect, it } from "vite-plus/test";

import { closeSkillTokenAtCursor, matchInlineSkills, replaceSpokenSkills } from "./inlineSkills.ts";

const skills = [
  { name: "review", displayName: undefined },
  { name: "poteto-mode", displayName: undefined },
  { name: "postplan-read", displayName: "PostPlan read" },
];

describe("replaceSpokenSkills", () => {
  it("rewrites anchored skill phrases into tokens the composer renders as chips", () => {
    const text = replaceSpokenSkills("Use the review skill to check this PR.", skills);
    expect(text).toBe("Use $review to check this PR.");
    expect([...matchInlineSkills(text, skills)].map((match) => match.skill.name)).toEqual([
      "review",
    ]);
    const sentences = replaceSpokenSkills("Use the review skill. Then run tests.", skills);
    expect(sentences).toBe("Use $review. Then run tests.");
    expect([...matchInlineSkills(sentences, skills)].map((match) => match.skill.name)).toEqual([
      "review",
    ]);
  });

  it("matches multi-word names, split words, and small recognition slips", () => {
    expect(replaceSpokenSkills("potato mode skill, fix the bug", skills)).toBe(
      "$poteto-mode, fix the bug",
    );
    expect(replaceSpokenSkills("run skill post plan read on it", skills)).toBe(
      "run $postplan-read on it",
    );
    expect(replaceSpokenSkills("dollar review please", skills)).toBe("$review please");
    const overlapping = [
      { name: "bug", displayName: undefined },
      { name: "fix-bug", displayName: undefined },
    ];
    expect(replaceSpokenSkills("use the fix bug skill", overlapping)).toBe("use $fix-bug");
    expect(replaceSpokenSkills("use the bug skill", overlapping)).toBe("use $bug");
  });

  it("leaves unanchored words and unknown skills alone", () => {
    expect(replaceSpokenSkills("please review the diff", skills)).toBe("please review the diff");
    expect(replaceSpokenSkills("use the deploy skill", skills)).toBe("use the deploy skill");
    expect(replaceSpokenSkills("I need to improve my review skills.", skills)).toBe(
      "I need to improve my review skills.",
    );
    expect(replaceSpokenSkills("use the review skill", [])).toBe("use the review skill");
  });
});

describe("closeSkillTokenAtCursor", () => {
  it("adds a space after a skill token that ends at the cursor", () => {
    expect(closeSkillTokenAtCursor("then run $review", 16, skills)).toEqual({
      text: "then run $review ",
      cursor: 17,
    });
  });

  it("leaves other text, unknown tokens, and already spaced tokens alone", () => {
    expect(closeSkillTokenAtCursor("then run $deploy", 16, skills).text).toBe("then run $deploy");
    expect(closeSkillTokenAtCursor("$review now", 7, skills).text).toBe("$review now");
    expect(closeSkillTokenAtCursor("costs $5", 8, skills).text).toBe("costs $5");
  });
});
