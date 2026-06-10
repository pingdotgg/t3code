import { retainSearchParams } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import {
  buildClosedDiffSearch,
  buildOpenDiffSearch,
  type DiffRouteSearch,
  parseDiffRouteSearch,
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

  it("parses working tree diff sources", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffSource: "unstaged",
      }),
    ).toEqual({
      diff: "1",
      diffSource: "unstaged",
    });

    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffSource: "staged",
      }),
    ).toEqual({
      diff: "1",
      diffSource: "staged",
    });
  });

  it("drops invalid working tree diff sources", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffSource: "working-tree",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("lets working tree diff source override stale turn values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffSource: "staged",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffSource: "staged",
      diffFilePath: "src/app.ts",
    });
  });

  it("keeps file value when working tree diff source is selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffSource: "unstaged",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffSource: "unstaged",
      diffFilePath: "src/app.ts",
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
  it("opens unstaged diff while stripping stale turn and file values", () => {
    expect(
      buildOpenDiffSearch(
        {
          diff: "1",
          diffSource: "staged",
          diffTurnId: "turn-1",
          diffFilePath: "src/app.ts",
          panel: "activity",
        },
        { source: "unstaged" },
      ),
    ).toEqual({
      diff: "1",
      diffSource: "unstaged",
      panel: "activity",
    });
  });

  it("opens the generic all-turns diff without a source", () => {
    expect(
      buildOpenDiffSearch({
        diff: "1",
        diffSource: "unstaged",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        panel: "activity",
      }),
    ).toEqual({
      diff: "1",
      panel: "activity",
    });
  });
});

describe("buildClosedDiffSearch", () => {
  it("marks diff params as intentionally closed for search middleware", () => {
    expect(
      buildClosedDiffSearch({
        diff: "1",
        diffSource: "unstaged",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        panel: "activity",
      }),
    ).toEqual({
      diff: undefined,
      diffSource: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      panel: "activity",
    });
  });

  it("prevents retained diff search params from reopening the panel", () => {
    const retainDiff = retainSearchParams<DiffRouteSearch>(["diff"]);

    expect(
      retainDiff({
        search: { diff: "1" },
        next: ((search: DiffRouteSearch, collectMeta?: true) => {
          const nextSearch = buildClosedDiffSearch(search);
          if (collectMeta) {
            return { search: nextSearch, meta: {} };
          }
          return nextSearch;
        }) as (search: DiffRouteSearch) => DiffRouteSearch,
      }),
    ).toEqual({
      diff: undefined,
      diffSource: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
    });
  });
});
