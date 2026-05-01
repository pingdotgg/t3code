import { TurnId } from "@forma/contracts";
import { describe, expect, it } from "vitest";

import {
  buildDiffClosedSearch,
  buildDiffEditorSearch,
  buildDiffFilesSearch,
  buildDiffOpenSearch,
  buildDiffTurnSearch,
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

  it("parses valid editor search values", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        diffView: "editor",
        editorFilePath: "src/app.ts",
        editorLine: "12",
        editorColumn: 4,
        editorBackToView: "diff",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
      diffView: "editor",
      editorFilePath: "src/app.ts",
      editorLine: 12,
      editorColumn: 4,
      editorBackToView: "diff",
    });
  });

  it("parses files view and normalizes legacy back-to-diff state", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffView: "files",
        editorFilePath: "ignored.ts",
      }),
    ).toEqual({
      diff: "1",
      diffView: "files",
    });

    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffView: "editor",
        editorFilePath: "src/app.ts",
        editorBackToDiff: true,
      }),
    ).toEqual({
      diff: "1",
      diffView: "editor",
      editorFilePath: "src/app.ts",
      editorBackToView: "diff",
    });
  });

  it("drops invalid editor combinations", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffView: "editor",
      }),
    ).toEqual({
      diff: "1",
    });

    expect(
      parseDiffRouteSearch({
        diff: "1",
        diffView: "editor",
        editorFilePath: "src/app.ts",
        editorLine: "0",
      }),
    ).toEqual({
      diff: "1",
      diffView: "editor",
      editorFilePath: "src/app.ts",
    });
  });

  it("drops editor line and column when file path is missing", () => {
    expect(
      parseDiffRouteSearch({
        diff: "1",
        editorLine: "12",
        editorColumn: "3",
      }),
    ).toEqual({
      diff: "1",
    });
  });
});

describe("diff route builders", () => {
  it("builds diff open, files, turn, editor, and close search objects", () => {
    const previous = {
      tab: "activity",
      diff: "1",
      diffTurnId: "turn-old",
      diffFilePath: "old.ts",
      diffView: "editor",
      editorFilePath: "old.ts",
      editorLine: 2,
      editorBackToView: "diff",
    };

    expect(buildDiffOpenSearch(previous)).toEqual({
      tab: "activity",
      diff: "1",
    });
    expect(buildDiffFilesSearch(previous)).toEqual({
      tab: "activity",
      diff: "1",
      diffTurnId: "turn-old",
      diffFilePath: "old.ts",
      diffView: "files",
    });
    expect(
      buildDiffTurnSearch(previous, {
        turnId: TurnId.make("turn-1"),
        filePath: "src/app.ts",
      }),
    ).toEqual({
      tab: "activity",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
    expect(
      buildDiffEditorSearch(previous, {
        filePath: "src/app.ts",
        line: 4,
        column: 8,
        turnId: TurnId.make("turn-1"),
        diffFilePath: "src/app.ts",
        backToView: "diff",
      }),
    ).toEqual({
      tab: "activity",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
      diffView: "editor",
      editorFilePath: "src/app.ts",
      editorLine: 4,
      editorColumn: 8,
      editorBackToView: "diff",
    });
    expect(buildDiffClosedSearch(previous)).toEqual({
      tab: "activity",
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      diffView: undefined,
      editorFilePath: undefined,
      editorLine: undefined,
      editorColumn: undefined,
      editorBackToView: undefined,
      editorBackToDiff: undefined,
    });
  });
});
