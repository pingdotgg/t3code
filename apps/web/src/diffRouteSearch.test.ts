import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildOpenDiffSearch, parseDiffRouteSearch } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });
});

describe("buildOpenDiffSearch", () => {
  it("clears preview state and sets diff state", () => {
    expect(
      buildOpenDiffSearch(
        {
          diff: "1",
          diffTurnId: "old-turn",
          diffFilePath: "old.ts",
          preview: "1",
          foo: "bar",
        },
        {
          diffTurnId: TurnId.make("turn-1"),
          diffFilePath: "src/app.ts",
        },
      ),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
      foo: "bar",
      preview: undefined,
    });
  });

  it("drops file selection when no turn is selected", () => {
    expect(
      buildOpenDiffSearch(
        {
          preview: "1",
          foo: "bar",
        },
        {
          diffFilePath: "src/app.ts",
        },
      ),
    ).toEqual({
      diff: "1",
      foo: "bar",
      preview: undefined,
    });
  });
});
