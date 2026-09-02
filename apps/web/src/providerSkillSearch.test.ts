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
  it("moves exact ui matches ahead of broader ui matches", () => {
    const skills = [
      makeSkill({
        name: "agent-browser",
        displayName: "Agent Browser",
        shortDescription: "Browser automation CLI for AI agents",
      }),
      makeSkill({
        name: "building-native-ui",
        displayName: "Building Native Ui",
        shortDescription: "Complete guide for building beautiful apps with Expo Router",
      }),
      makeSkill({
        name: "ui",
        displayName: "Ui",
        shortDescription: "Explore, build, and refine UI.",
      }),
    ];

    expect(searchProviderSkills(skills, "ui").map((skill) => skill.name)).toEqual([
      "ui",
      "building-native-ui",
    ]);
  });

  it("uses fuzzy ranking for abbreviated queries", () => {
    const skills = [
      makeSkill({ name: "gh-fix-ci", displayName: "Gh Fix Ci" }),
      makeSkill({ name: "github", displayName: "Github" }),
      makeSkill({ name: "agent-browser", displayName: "Agent Browser" }),
    ];

    expect(searchProviderSkills(skills, "gfc").map((skill) => skill.name)).toEqual(["gh-fix-ci"]);
  });

  it("keeps user-only skills and omits agent-only ones", () => {
    const skills = [
      makeSkill({ name: "re-release-version", userInvocationOnly: true }),
      makeSkill({ name: "release-context", userInvocable: false }),
      makeSkill({ name: "release-version" }),
    ];

    expect(searchProviderSkills(skills, "release").map((skill) => skill.name)).toEqual([
      "release-version",
      "re-release-version",
    ]);
  });

  it("omits disabled skills from results", () => {
    const skills = [
      makeSkill({ name: "ui", displayName: "Ui", enabled: false }),
      makeSkill({ name: "frontend-design", displayName: "Frontend Design" }),
    ];

    expect(searchProviderSkills(skills, "ui").map((skill) => skill.name)).toEqual([]);
  });

  it("returns every enabled skill for an empty query", () => {
    const skills = [
      makeSkill({ name: "unslop" }),
      makeSkill({ name: "browser" }),
      makeSkill({ name: "disabled", enabled: false }),
    ];

    expect(searchProviderSkills(skills, "").map((skill) => skill.name)).toEqual([
      "unslop",
      "browser",
    ]);
  });

  it("returns the first enabled definition for each skill name", () => {
    const skills = [
      makeSkill({ name: "branch-audit", path: "/Users/matt/.codex/skills/branch-audit/SKILL.md" }),
      makeSkill({ name: "browser" }),
      makeSkill({ name: "branch-audit", path: "/Users/matt/.agents/skills/branch-audit/SKILL.md" }),
    ];

    expect(searchProviderSkills(skills, "").map((skill) => skill.path)).toEqual([
      "/Users/matt/.codex/skills/branch-audit/SKILL.md",
      "/tmp/browser/SKILL.md",
    ]);
  });
});
