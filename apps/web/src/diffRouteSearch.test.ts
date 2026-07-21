import { describe, expect, it } from "vitest";

import { buildClosedDiffRouteSearch, parseDiffRouteSearch } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
      diffScope: "turn",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
      diffScope: "turn",
    });
  });

  it("drops invalid scope values and scope without a selected turn", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffTurnId: "turn-1",
        diffScope: "invalid",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffScope: "turn",
      }),
    ).toEqual({
      diff: "1",
    });
  });

  it("parses explicit aggregate views and drops turn selection", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffView: "chat",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
      }),
    ).toEqual({
      diff: "1",
      diffView: "chat",
    });
  });

  it("routes review findings to the uncommitted snapshot", () => {
    expect(parseDiffRouteSearch({ diff: "1", reviewFinding: "finding-1" })).toEqual({
      diff: "1",
      diffView: "uncommitted",
      reviewFinding: "finding-1",
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

describe("buildClosedDiffRouteSearch", () => {
  it("returns explicit undefined keys for diff state", () => {
    expect(buildClosedDiffRouteSearch()).toEqual({
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      diffScope: undefined,
      diffView: undefined,
      reviewFinding: undefined,
    });
  });
});
