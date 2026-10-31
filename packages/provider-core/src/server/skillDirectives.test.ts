import { assert, describe, it } from "@effect/vitest";

import { claudeSkillVariantName, renderSkillDirectives } from "./skillDirectives.ts";

describe("renderSkillDirectives", () => {
  it("renders sorted generic directives with escaped skill names", () => {
    const text = renderSkillDirectives([
      { skillName: 'zeta<&"', mode: "off", variantPath: null },
      {
        skillName: "beta",
        mode: "variant",
        variantPath: "/state/skill-variants/hash/SKILL.md",
      },
    ]);

    assert.equal(
      text,
      [
        "<t3_skill_variants>",
        "T3 Code adjusts some skills for this model.",
        '- Skill "beta": use /state/skill-variants/hash/SKILL.md instead of its own SKILL.md.',
        '- Skill "zeta&lt;&amp;&quot;": do not use it for this model.',
        "</t3_skill_variants>",
      ].join("\n"),
    );
  });

  it("renders Claude variants by plugin-qualified name", () => {
    assert.equal(
      renderSkillDirectives(
        [{ skillName: "review", mode: "variant", variantPath: "/variants/review/SKILL.md" }],
        { variantReference: "claude-plugin" },
      ),
      [
        "<t3_skill_variants>",
        "T3 Code adjusts some skills for this model.",
        '- Skill "review": use "t3-variants:review-t3-variant" for this model instead.',
        "</t3_skill_variants>",
      ].join("\n"),
    );
  });

  it("keeps truncated Claude variant names stable and collision resistant", () => {
    const sharedPrefix = "a".repeat(80);
    const first = claudeSkillVariantName(`${sharedPrefix}-first`);
    const second = claudeSkillVariantName(`${sharedPrefix}-second`);

    assert.equal(first, claudeSkillVariantName(`${sharedPrefix}-first`));
    assert.notEqual(first, second);
    assert.isAtMost(first.length, 64);
    assert.isAtMost(second.length, 64);
    assert.match(first, /^[a-zA-Z0-9._-]+$/);
    assert.match(second, /^[a-zA-Z0-9._-]+$/);
  });

  it("returns an empty string without deliverable overrides", () => {
    assert.equal(
      renderSkillDirectives([{ skillName: "beta", mode: "variant", variantPath: null }]),
      "",
    );
  });
});
