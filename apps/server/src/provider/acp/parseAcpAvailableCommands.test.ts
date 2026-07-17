import { describe, expect, it } from "@effect/vitest";

import { parseAcpAvailableCommands } from "./parseAcpAvailableCommands.ts";

describe("parseAcpAvailableCommands", () => {
  it("maps ACP available commands into provider slash commands", () => {
    expect(
      parseAcpAvailableCommands([
        {
          name: "factory-planner",
          description: "Plan factory tickets",
          input: { hint: "ticket intent" },
        },
        {
          name: "context",
          description: "Show context usage",
        },
      ]),
    ).toEqual([
      {
        name: "factory-planner",
        description: "Plan factory tickets",
        input: { hint: "ticket intent" },
      },
      {
        name: "context",
        description: "Show context usage",
      },
    ]);
  });

  it("dedupes by case-insensitive name and keeps the first description/hint", () => {
    expect(
      parseAcpAvailableCommands([
        { name: "Trade-Research", description: "first", input: { hint: "ticker" } },
        { name: "trade-research", description: "second", input: { hint: "other" } },
        { name: "  ", description: "ignored" },
      ]),
    ).toEqual([
      {
        name: "Trade-Research",
        description: "first",
        input: { hint: "ticker" },
      },
    ]);
  });

  it("returns an empty list for nullish input", () => {
    expect(parseAcpAvailableCommands(undefined)).toEqual([]);
    expect(parseAcpAvailableCommands(null)).toEqual([]);
    expect(parseAcpAvailableCommands([])).toEqual([]);
  });
});
