import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch } from "./diffRouteSearch";

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

  it("parses split thread params independently of diff", () => {
    expect(
      parseDiffRouteSearch({
        splitEnvironmentId: "env-a",
        splitThreadId: "thread-b",
      }),
    ).toEqual({
      splitEnvironmentId: "env-a",
      splitThreadId: "thread-b",
    });
  });

  it("ignores split params when only one side is present", () => {
    expect(
      parseDiffRouteSearch({
        splitEnvironmentId: "env-a",
      }),
    ).toEqual({});

    expect(
      parseDiffRouteSearch({
        splitThreadId: "thread-b",
      }),
    ).toEqual({});
  });

  it("parses diff thread target override only when diff is open", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffThreadEnvironmentId: "env-x",
        diffThreadId: "thread-y",
      }),
    ).toEqual({
      diff: "1",
      diffThreadEnvironmentId: "env-x",
      diffThreadId: "thread-y",
    });

    expect(
      parseDiffRouteSearch({
        diffThreadEnvironmentId: "env-x",
        diffThreadId: "thread-y",
      }),
    ).toEqual({});
  });
});
