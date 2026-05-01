import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses turn and file selection values", () => {
    const parsed = parseDiffRouteSearch({
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("ignores legacy 'diff' open/closed flag", () => {
    // The diff panel open/closed state moved to the UI store. Old URLs that
    // still carry ?diff=1 must not surface as anything in the parsed search.
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(parsed).toEqual({
      diffTurnId: "turn-1",
    });
    expect("diff" in parsed).toBe(false);
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({});
  });
});
