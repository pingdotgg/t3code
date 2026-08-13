import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderSkill } from "@t3tools/contracts";

import { resolveComposerSkills, searchProviderSkills } from "./providerSkillSearch";

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

  it("omits disabled skills from results", () => {
    const skills = [
      makeSkill({ name: "ui", displayName: "Ui", enabled: false }),
      makeSkill({ name: "frontend-design", displayName: "Frontend Design" }),
    ];

    expect(searchProviderSkills(skills, "ui").map((skill) => skill.name)).toEqual([]);
  });
});

describe("resolveComposerSkills", () => {
  const snapshotSkills = [makeSkill({ name: "snapshot-skill" })];
  const workspaceSkills = [makeSkill({ name: "workspace-skill" })];

  it("prefers the workspace answer over the provider snapshot", () => {
    expect(
      resolveComposerSkills(workspaceSkills, snapshotSkills).map((skill) => skill.name),
    ).toEqual(["workspace-skill"]);
  });

  it("keeps the snapshot list when discovery could not run", () => {
    expect(resolveComposerSkills(null, snapshotSkills).map((skill) => skill.name)).toEqual([
      "snapshot-skill",
    ]);
    expect(resolveComposerSkills(undefined, snapshotSkills).map((skill) => skill.name)).toEqual([
      "snapshot-skill",
    ]);
  });

  it("honours a workspace that genuinely has no skills", () => {
    expect(resolveComposerSkills([], snapshotSkills)).toEqual([]);
  });

  it("returns a stable empty list when nothing is known at all", () => {
    expect(resolveComposerSkills(null, undefined)).toBe(
      resolveComposerSkills(undefined, undefined),
    );
  });
});
