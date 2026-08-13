import { describe, expect, it } from "@effect/vitest";

import { parseGrokInspectSkills } from "./GrokSkills.ts";

describe("parseGrokInspectSkills", () => {
  it("maps inspect JSON onto ServerProviderSkill rows", () => {
    expect(
      parseGrokInspectSkills({
        skills: [
          {
            name: "handoff-session",
            description: "Write a session handoff.",
            userInvocable: true,
            source: { type: "user", path: "/tmp/.grok/skills/handoff-session/SKILL.md" },
          },
          {
            name: "ce-plan",
            description: "Create structured plans.",
            userInvocable: true,
            source: {
              type: "plugin",
              plugin_name: "compound-engineering",
              path: "/tmp/plugins/ce-plan/SKILL.md",
            },
          },
        ],
      }),
    ).toEqual([
      {
        name: "handoff-session",
        description: "Write a session handoff.",
        path: "/tmp/.grok/skills/handoff-session/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "ce-plan",
        description: "Create structured plans.",
        path: "/tmp/plugins/ce-plan/SKILL.md",
        scope: "plugin:compound-engineering",
        enabled: true,
      },
    ]);
  });

  it("skips malformed rows and keeps the first name on collisions", () => {
    expect(
      parseGrokInspectSkills({
        skills: [
          {
            name: "review",
            source: { type: "project", path: "/repo/.grok/skills/review/SKILL.md" },
          },
          { name: "review", source: { type: "user", path: "/home/.grok/skills/review/SKILL.md" } },
          { name: "broken" },
          null,
          "nope",
        ],
      }),
    ).toEqual([
      {
        name: "review",
        path: "/repo/.grok/skills/review/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ]);
  });

  it("marks non-invocable or disabled skills as disabled", () => {
    const skills = parseGrokInspectSkills({
      skills: [
        {
          name: "hidden",
          userInvocable: false,
          source: { type: "bundled", path: "/bundled/hidden/SKILL.md" },
        },
        {
          name: "off",
          disabled: true,
          source: { type: "user", path: "/home/.grok/skills/off/SKILL.md" },
        },
      ],
    });
    expect(skills.map((skill) => ({ name: skill.name, enabled: skill.enabled }))).toEqual([
      { name: "hidden", enabled: false },
      { name: "off", enabled: false },
    ]);
  });

  it("returns an empty list for junk input", () => {
    expect(parseGrokInspectSkills(null)).toEqual([]);
    expect(parseGrokInspectSkills({})).toEqual([]);
    expect(parseGrokInspectSkills({ skills: "nope" })).toEqual([]);
  });
});
