import { expect, it } from "@effect/vitest";

import { parsePiDiscoveredCommands } from "./commands.ts";

it("maps current Pi skill metadata to T3's user and project skill scopes", () => {
  expect(
    parsePiDiscoveredCommands({
      commands: [
        {
          name: "skill:global-review",
          description: "Review changes.",
          source: "skill",
          sourceInfo: {
            path: "/home/test/.agents/skills/global-review/SKILL.md",
            scope: "user",
          },
        },
        {
          name: "skill:project-deploy",
          description: "Deploy this project.",
          source: "skill",
          sourceInfo: {
            path: "/workspace/.agents/skills/project-deploy/SKILL.md",
            scope: "project",
          },
        },
        { name: "hello", description: "Say hello.", source: "extension" },
      ],
    }),
  ).toEqual({
    skills: [
      {
        name: "global-review",
        description: "Review changes.",
        path: "/home/test/.agents/skills/global-review/SKILL.md",
        scope: "user",
        enabled: true,
      },
      {
        name: "project-deploy",
        description: "Deploy this project.",
        path: "/workspace/.agents/skills/project-deploy/SKILL.md",
        scope: "project",
        enabled: true,
      },
    ],
    slashCommands: [{ name: "hello", description: "Say hello." }],
  });
});
