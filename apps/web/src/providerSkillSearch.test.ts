import { describe, expect, it } from "vitest";

import { ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";

import { providerSkillsFromCatalog, searchProviderSkills } from "./providerSkillSearch";

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

  describe("providerSkillsFromCatalog", () => {
    it("returns skills readable by the selected provider", () => {
      const skills = providerSkillsFromCatalog(
        [
          {
            id: "agent-browser",
            name: "agent-browser",
            displayName: "Agent Browser",
            canonicalPath: "/home/test/.copilot/skills/agent-browser",
            paths: ["/home/test/.copilot/skills/agent-browser"],
            installations: [
              {
                agentId: "copilot-cli",
                agentName: "Copilot CLI",
                path: "/home/test/.copilot/skills/agent-browser",
                source: "primary",
              },
            ],
            hasPathConflict: false,
          },
        ],
        ProviderDriverKind.make("copilot"),
      );

      expect(skills).toEqual([
        {
          name: "agent-browser",
          displayName: "Agent Browser",
          path: "/home/test/.copilot/skills/agent-browser",
          enabled: true,
        },
      ]);
    });
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
