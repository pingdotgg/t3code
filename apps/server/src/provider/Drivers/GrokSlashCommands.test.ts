import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderSkill } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  parseGrokAvailableCommands,
  resolveGrokSlashCommands,
  slashCommandsFromGrokSkills,
} from "./GrokSlashCommands.ts";

describe("parseGrokAvailableCommands", () => {
  it("maps ACP available commands into slash commands with hints", () => {
    const commands = parseGrokAvailableCommands([
      {
        name: "compact",
        description: "Compress conversation history",
        input: { hint: "optional context" },
      },
      {
        name: "super-review",
        description: "Bugs-only super review",
      },
      {
        name: "  ",
        description: "ignored empty name",
      },
    ] as ReadonlyArray<EffectAcpSchema.AvailableCommand>);

    assert.deepEqual(commands, [
      {
        name: "compact",
        description: "Compress conversation history",
        input: { hint: "optional context" },
      },
      {
        name: "super-review",
        description: "Bugs-only super review",
      },
    ]);
  });

  it("dedupes by case-insensitive name and fills missing metadata", () => {
    const commands = parseGrokAvailableCommands([
      { name: "Review", description: "" },
      { name: "review", description: "Run a review", input: { hint: "[--local]" } },
    ] as ReadonlyArray<EffectAcpSchema.AvailableCommand>);

    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], {
      name: "Review",
      description: "Run a review",
      input: { hint: "[--local]" },
    });
  });
});

describe("slashCommandsFromGrokSkills", () => {
  it("only includes enabled skills", () => {
    const skills = [
      {
        name: "super-review",
        path: "/user/super-review/SKILL.md",
        enabled: true,
        description: "Bugs-only super review",
      },
      {
        name: "docx",
        path: "/bundled/docx/SKILL.md",
        enabled: false,
        description: "hidden",
      },
    ] satisfies ReadonlyArray<ServerProviderSkill>;

    assert.deepEqual(slashCommandsFromGrokSkills(skills), [
      {
        name: "super-review",
        description: "Bugs-only super review",
      },
    ]);
  });
});

describe("resolveGrokSlashCommands", () => {
  it("merges ACP commands with invocable skills not already advertised", () => {
    const skills = [
      {
        name: "super-review",
        path: "/user/super-review/SKILL.md",
        enabled: true,
        description: "from skill",
      },
      {
        name: "compact",
        path: "/user/compact/SKILL.md",
        enabled: true,
        description: "skill should not replace acp",
      },
    ] satisfies ReadonlyArray<ServerProviderSkill>;

    const commands = resolveGrokSlashCommands({
      availableCommands: [
        {
          name: "compact",
          description: "from acp",
        },
      ] as ReadonlyArray<EffectAcpSchema.AvailableCommand>,
      skills,
    });

    assert.deepEqual(commands, [
      { name: "compact", description: "from acp" },
      { name: "super-review", description: "from skill" },
    ]);
  });

  it("falls back to invocable skills when ACP advertised none", () => {
    const skills = [
      {
        name: "apple-design",
        path: "/user/apple-design/SKILL.md",
        enabled: true,
        description: "Apple HIG",
      },
    ] satisfies ReadonlyArray<ServerProviderSkill>;

    const commands = resolveGrokSlashCommands({
      availableCommands: [],
      skills,
    });

    assert.deepEqual(commands, [{ name: "apple-design", description: "Apple HIG" }]);
  });
});
