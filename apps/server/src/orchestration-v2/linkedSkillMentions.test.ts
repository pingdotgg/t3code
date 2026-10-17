import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { expandLinkedSkillMentions, spellOutLinkedSkillMentions } from "./linkedSkillMentions.ts";

const projectReview = "/repo/.claude/skills/review/SKILL.md";

describe("expandLinkedSkillMentions", () => {
  it("replaces a linked mention with the name and points at the picked file", () => {
    expect(expandLinkedSkillMentions(`Run [$review](${projectReview}) on this diff`)).toBe(
      `Run review on this diff\n\nThe user invoked the \`review\` skill defined in ${projectReview}. Read that file and follow its instructions, not those of any other skill named \`review\`.`,
    );
  });

  it("names each picked file once, decoded, and leaves plain mentions alone", () => {
    const link = "[$review](/my%20skills/review/SKILL.md)";
    const expanded = expandLinkedSkillMentions(`${link} first, then $lint and ${link}`);
    expect(expanded.startsWith("review first, then $lint and review\n\n")).toBe(true);
    expect(expanded.split("defined in /my skills/review/SKILL.md.")).toHaveLength(2);
  });
});

describe("spellOutLinkedSkillMentions", () => {
  const input = { message: { text: `[$review](${projectReview})` } };

  it("leaves Codex the link, which its adapter sends as a skill input", () => {
    expect(spellOutLinkedSkillMentions(ProviderDriverKind.make("codex"), input)).toBe(input);
  });

  it("spells the link out for providers that invoke skills by name", () => {
    expect(
      spellOutLinkedSkillMentions(ProviderDriverKind.make("claudeAgent"), input).message.text,
    ).toContain(`defined in ${projectReview}.`);
  });
});
