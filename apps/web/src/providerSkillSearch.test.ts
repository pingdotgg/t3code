import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderSkill } from "@t3tools/contracts";

import { searchProviderSkills } from "./providerSkillSearch";

function makeSkill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, "name">) {
  return {
    path: `/tmp/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill;
}

describe("searchProviderSkills", () => {
  // regression: #12098 unicode currency symbols must work as skill aliases
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "searches skills with a %s prefix",
    (prefix) => {
      const skill = makeSkill({ name: "review" });
      expect(searchProviderSkills([skill], `${prefix}review`)).toEqual([skill]);
    },
  );

  it("uses fuzzy ranking for abbreviated queries", () => {
    const skills = [
      makeSkill({ name: "gh-fix-ci", displayName: "Gh Fix Ci" }),
      makeSkill({ name: "github", displayName: "Github" }),
      makeSkill({ name: "agent-browser", displayName: "Agent Browser" }),
    ];

    expect(searchProviderSkills(skills, "gfc").map((skill) => skill.name)).toEqual(["gh-fix-ci"]);
  });

  it("returns each enabled skill file once, including same-name files", () => {
    const skills = [
      makeSkill({ name: "branch-audit", path: "/Users/matt/.codex/skills/branch-audit/SKILL.md" }),
      makeSkill({ name: "browser" }),
      makeSkill({ name: "branch-audit", path: "/Users/matt/.agents/skills/branch-audit/SKILL.md" }),
      makeSkill({ name: "browser" }),
    ];

    expect(searchProviderSkills(skills, "").map((skill) => skill.path)).toEqual([
      "/Users/matt/.codex/skills/branch-audit/SKILL.md",
      "/tmp/browser/SKILL.md",
      "/Users/matt/.agents/skills/branch-audit/SKILL.md",
    ]);
  });
});
