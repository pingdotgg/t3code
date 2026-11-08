import { expect, it } from "@effect/vitest";

import { parseOmpDiscoveredCommands } from "./commands.ts";

it("maps current Omp skill metadata to T3's user and project skill scopes", () => {
  expect(
    parseOmpDiscoveredCommands({
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

it("preserves OMP native command hints and exact thinking metadata", () => {
  expect(
    parseOmpDiscoveredCommands({
      commands: [
        {
          name: "switch",
          source: "builtin",
          description: "Switch model",
          input: { hint: "[model]" },
        },
      ],
    }).slashCommands,
  ).toEqual([{ name: "switch", description: "Switch model", input: { hint: "[model]" } }]);
});
