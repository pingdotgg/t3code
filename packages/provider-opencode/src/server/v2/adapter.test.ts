import { assert, describe, it } from "@effect/vitest";

import {
  buildOpenCode2Instructions,
  openCode2PromptSkills,
  openCode2RulesNeedUpdate,
  openCode2SkillRules,
} from "./adapter.ts";

describe("buildOpenCode2Instructions", () => {
  it("appends skill directives to the per-turn instruction entry", () => {
    const directive = "<t3_skill_variants>\nvariant instructions\n</t3_skill_variants>";
    const instructions = buildOpenCode2Instructions({
      model: "anthropic/claude-sonnet",
      hasT3Mcp: true,
      hasDeviceTools: false,
      skillDirectives: { text: directive, hash: "directive-hash" },
    });

    assert.isTrue(instructions.endsWith(directive));
  });
});

describe("OpenCode v2 skill permissions", () => {
  const policy = {
    hash: "policy-a",
    entries: [
      { skillName: "off-skill", mode: "off" as const, variantPath: null },
      {
        skillName: "variant-skill",
        mode: "variant" as const,
        variantPath: "/state/skill-variants/content/SKILL.md",
      },
    ],
  };

  it("places scoped variant access before exact base-skill denies", () => {
    assert.deepEqual(openCode2SkillRules(policy), [
      {
        action: "external_directory",
        resource: "/state/skill-variants/content/*",
        effect: "allow",
      },
      { action: "skill", resource: "off-skill", effect: "deny" },
      { action: "skill", resource: "variant-skill", effect: "deny" },
    ]);
  });

  it("omits governed base skills from explicit prompt attachments", () => {
    const known = new Set(["off-skill", "variant-skill", "base-skill"]);
    assert.deepEqual(
      openCode2PromptSkills("$off-skill then $variant-skill then $base-skill", known, policy),
      ["base-skill"],
    );
  });

  it("preserves ungoverned prompt skill attachments", () => {
    assert.deepEqual(
      openCode2PromptSkills("$base-skill inspect this", new Set(["base-skill"]), undefined),
      ["base-skill"],
    );
  });

  it("updates reused sessions when only the policy identity changes", () => {
    const rules = openCode2SkillRules(policy);
    assert.isFalse(
      openCode2RulesNeedUpdate({
        currentRules: rules,
        currentSkillPolicyHash: "policy-a",
        nextRules: rules,
        nextSkillPolicyHash: "policy-a",
      }),
    );
    assert.isTrue(
      openCode2RulesNeedUpdate({
        currentRules: rules,
        currentSkillPolicyHash: "policy-a",
        nextRules: rules,
        nextSkillPolicyHash: "policy-b",
      }),
    );
  });
});
