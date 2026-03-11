import { describe, expect, it } from "vitest";

import {
  clearDiffSearchParams,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "./diffRouteSearch";

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

describe("stripDiffSearchParams", () => {
  it("removes diff search keys", () => {
    const stripped = stripDiffSearchParams({
      diff: "1",
      diffFilePath: "src/app.ts",
      diffTurnId: "turn-1",
      project: "demo",
    });

    expect(stripped).toEqual({ project: "demo" });
    expect("diff" in stripped).toBe(false);
    expect("diffTurnId" in stripped).toBe(false);
    expect("diffFilePath" in stripped).toBe(false);
  });
});

describe("clearDiffSearchParams", () => {
  it("keeps explicit undefined tombstones for diff keys", () => {
    const cleared = clearDiffSearchParams({
      diff: "1",
      diffFilePath: "src/app.ts",
      diffTurnId: "turn-1",
      project: "demo",
    });

    expect(cleared).toEqual({
      diff: undefined,
      diffFilePath: undefined,
      diffTurnId: undefined,
      project: "demo",
    });
    expect("diff" in cleared).toBe(true);
    expect("diffTurnId" in cleared).toBe(true);
    expect("diffFilePath" in cleared).toBe(true);
  });
});
