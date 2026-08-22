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

  it("omits skills only the user can invoke", () => {
    // `$` puts the name in the prompt as prose, and the agent cannot see this
    // skill at all — it belongs in the slash-command menu instead.
    const skills = [
      makeSkill({ name: "re-release-version", userInvocationOnly: true }),
      makeSkill({ name: "release-version" }),
    ];

    expect(searchProviderSkills(skills, "release").map((skill) => skill.name)).toEqual([
      "release-version",
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
});
