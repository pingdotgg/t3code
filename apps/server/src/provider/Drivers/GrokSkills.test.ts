import { describe, expect, it } from "@effect/vitest";

import { parseGrokInspectSkills } from "./GrokSkills.ts";

const inspectPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

describe("parseGrokInspectSkills", () => {
  it("maps inspect entries onto provider skills, sorted by name", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "writing-docs",
          description: "Write user docs.",
          source: { type: "user", path: "/home/dev/.grok/skills/writing-docs/SKILL.md" },
          userInvocable: true,
        },
        {
          name: "deploy",
          description: "Deploy the app.",
          source: {
            type: "plugin",
            path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
          },
          userInvocable: true,
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "deploy",
        description: "Deploy the app.",
        path: "/home/dev/.grok/installed-plugins/pkg/plug/skills/deploy/SKILL.md",
        scope: "plugin",
        enabled: true,
      },
      {
        name: "writing-docs",
        description: "Write user docs.",
        path: "/home/dev/.grok/skills/writing-docs/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("disables skills the CLI marks as not user-invocable", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        {
          name: "internal-helper",
          source: { type: "bundled", path: "/opt/grok/bundled/skills/internal-helper/SKILL.md" },
          userInvocable: false,
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "internal-helper",
        path: "/opt/grok/bundled/skills/internal-helper/SKILL.md",
        scope: "bundled",
        enabled: false,
      },
    ]);
  });

  it("skips entries without a name or a filesystem path", () => {
    const skills = parseGrokInspectSkills(
      inspectPayload([
        { name: "  ", source: { type: "user", path: "/tmp/skills/a/SKILL.md" } },
        { name: "no-path", source: { type: "user" } },
        { name: "no-source" },
        "not-an-object",
        { name: "kept", source: { type: "project", path: "/repo/.grok/skills/kept/SKILL.md" } },
      ]),
    );

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
  });

  it("returns an empty list for malformed or unexpected output", () => {
    expect(parseGrokInspectSkills("not json")).toEqual([]);
    expect(parseGrokInspectSkills("null")).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({ skills: "nope" }))).toEqual([]);
    expect(parseGrokInspectSkills(JSON.stringify({}))).toEqual([]);
  });
});
