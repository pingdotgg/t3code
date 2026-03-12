import { stripSearchParams } from "@tanstack/react-router";
import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  closeDiffSearchParams,
  type DiffRouteSearchNavigation,
  parseDiffRouteSearch,
  parseDiffRouteSearchNavigation,
  retainDiffSearchParams,
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

  it("builds an explicit close navigation payload", () => {
    expect(
      closeDiffSearchParams({
        diff: "1",
        diffTurnId: TurnId.makeUnsafe("turn-1"),
        diffFilePath: "src/app.ts",
      }),
    ).toEqual({
      clearDiff: "1",
    });
  });

  it("parses route control flags for navigation middleware", () => {
    expect(
      parseDiffRouteSearchNavigation({
        clearDiff: "1",
      }),
    ).toEqual({
      clearDiff: "1",
    });
  });

  it("retains diff across navigations that do not touch diff state", () => {
    expect(
      retainDiffSearchParams({
        search: {
          diff: "1",
        },
        next: () => ({}),
      }),
    ).toEqual({
      diff: "1",
    });
  });

  it("does not reinsert diff when navigation explicitly clears it", () => {
    const stripped = stripSearchParams<DiffRouteSearchNavigation>(["clearDiff"]);

    const nextSearch = stripped({
      search: {
        diff: "1",
      },
      next: (search) =>
        retainDiffSearchParams({
          search,
          next: () => closeDiffSearchParams(search),
        }),
    });

    expect(nextSearch).toEqual({});
  });
});
