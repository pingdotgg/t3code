import { describe, expect, it } from "@effect/vitest";

import {
  mapAcpAvailableCommandsToProviderCatalog,
  mapOpenCodeSdkCatalogToProviderCatalog,
  providerCommandCatalogIsEmpty,
} from "./providerCommandCatalog.ts";

describe("mapOpenCodeSdkCatalogToProviderCatalog", () => {
  it("maps commands to slash entries and skills to path-backed skills", () => {
    const catalog = mapOpenCodeSdkCatalogToProviderCatalog({
      commands: [
        { name: "review", description: "Review changes", hints: ["$ARGUMENTS"] },
        { name: "to-prd", description: "PRD skill command", source: "skill", hints: [] },
      ],
      skills: [
        {
          name: "to-prd",
          description: "Write a PRD",
          location: "/Users/me/.agents/skills/to-prd/SKILL.md",
        },
        {
          name: "customize-opencode",
          description: "Config skill",
          location: "<built-in>",
        },
      ],
    });

    expect(catalog.slashCommands.map((command) => command.name)).toEqual(["review", "to-prd"]);
    expect(catalog.slashCommands[0]).toMatchObject({
      name: "review",
      input: { hint: "$ARGUMENTS" },
    });
    expect(catalog.skills).toEqual([
      {
        name: "customize-opencode",
        description: "Config skill",
        path: "opencode://skill/customize-opencode",
        scope: "built-in",
        enabled: true,
      },
      {
        name: "to-prd",
        description: "Write a PRD",
        path: "/Users/me/.agents/skills/to-prd/SKILL.md",
        enabled: true,
      },
    ]);
    expect(providerCommandCatalogIsEmpty(catalog)).toBe(false);
  });
});

describe("mapAcpAvailableCommandsToProviderCatalog", () => {
  it("still maps path-backed ACP commands to skills", () => {
    const catalog = mapAcpAvailableCommandsToProviderCatalog([
      {
        name: "compact",
        description: "Compress history",
        input: { hint: "optional context" },
      },
      {
        name: "diag",
        description: "Debug",
        _meta: { path: "/tmp/diag/SKILL.md", scope: "user" },
      },
    ]);

    expect(catalog.slashCommands).toHaveLength(2);
    expect(catalog.skills).toEqual([
      {
        name: "diag",
        description: "Debug",
        path: "/tmp/diag/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });
});
