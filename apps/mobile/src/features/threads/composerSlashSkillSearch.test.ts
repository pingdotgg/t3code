import { describe, expect, it } from "vite-plus/test";

import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

const browserSkill = {
  name: "browser",
  path: "/skills/browser/SKILL.md",
  enabled: true,
  shortDescription: "Open and control the in-app browser",
};

describe("matchesSlashSkillQuery", () => {
  it("matches the rendered skill prefix", () => {
    expect(matchesSlashSkillQuery(browserSkill, ["skill"])).toBe(true);
    expect(matchesSlashSkillQuery(browserSkill, ["skill:brow"])).toBe(true);
  });

  it("matches a keyboard layout variant of the query", () => {
    // `бров` is `brow` typed while a Russian layout was active.
    expect(matchesSlashSkillQuery(browserSkill, ["бров"])).toBe(false);
    expect(matchesSlashSkillQuery(browserSkill, ["бров", "brow"])).toBe(true);
  });
});
