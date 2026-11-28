import { highlightCode } from "../../lib/highlights";

import {
  EnvironmentId,
  GitCommandError,
  type ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { highlightNativeReviewDiffVisibleRows } from "../diffs/nativeReviewDiffHighlighter";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { createReviewDiffHighlightFiles } from "./reviewDiffHighlightFiles";
import { buildReviewParsedDiff } from "./reviewModel";

vi.mock("react-native-nitro-modules", async () => {
  const { createWasmHighlightsModule } = await import("../../lib/highlights.testing");
  const highlights = createWasmHighlightsModule();
  return { NitroModules: { hasHybridObject: () => true, createHybridObject: () => highlights } };
});

const source = {
  environmentId: EnvironmentId.make("environment"),
  cwd: "/repo",
  sourceKind: "revision-range" as const,
  baseRef: "turn-start",
  headRef: "refs/t3/turn/2",
  diffKey: "turn:2",
};
const docstring = (line: string) =>
  ["def load():", '    """', "    Reads settings.", "", "    Notes:", line, '    """', ""].join(
    "\n",
  );
const oldContents = docstring("    the result is not a dict of dicts");
const newContents = docstring("    the result is and is not a dict");
const patch = [
  "diff --git a/settings.py b/settings.py",
  "--- a/settings.py",
  "+++ b/settings.py",
  "@@ -5,3 +5,3 @@ def load():",
  "     Notes:",
  "-    the result is not a dict of dicts",
  "+    the result is and is not a dict",
  '     """',
  "diff --git a/top.py b/top.py",
  "--- a/top.py",
  "+++ b/top.py",
  "@@ -1,2 +1,2 @@",
  "-x = 1",
  "+x = 2",
  " y = 3",
  "",
].join("\n");

function setup() {
  const parsed = buildReviewParsedDiff(patch, "scope");
  const data = buildNativeReviewDiffData(parsed);
  return { parsed, data };
}

it("colours a hunk inside a docstring from the whole file, and leaves files that start at the top", async () => {
  const { parsed, data } = setup();
  const fetch = vi.fn(async () => AsyncResult.success({ oldContents, newContents }));
  const files = createReviewDiffHighlightFiles(source, parsed, data.files, fetch);

  expect(files[1]!.loadContents).toBeUndefined();
  const rowIndex = data.rows.findIndex(
    (row) => row.kind === "line" && row.content === "    the result is and is not a dict",
  );
  const result = await highlightNativeReviewDiffVisibleRows({
    rows: data.rows,
    files,
    scheme: "dark",
    firstRowIndex: rowIndex,
    lastRowIndex: rowIndex,
    overscanRows: 0,
  });

  expect(fetch).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      cwd: "/repo",
      sourceKind: "revision-range",
      changeType: "change",
      baseRef: "turn-start",
      headRef: "refs/t3/turn/2",
      oldPath: "settings.py",
      newPath: "settings.py",
    },
  });
  expect(result.tokensByRowId[data.rows[rowIndex]!.id]).toEqual(
    highlightCode(newContents, "python", "dark")[5],
  );
});

it("keeps patch colours and stops asking for a file the server cannot read", async () => {
  const { parsed, data } = setup();
  const error = new GitCommandError({
    operation: "read",
    command: "git",
    cwd: "/repo",
    detail: "Git output exceeded the size limit.",
  });
  const fetch = vi.fn(async () =>
    AsyncResult.failure<ReviewDiffFileContentsResult, GitCommandError>(Cause.fail(error)),
  );
  const files = createReviewDiffHighlightFiles(source, parsed, data.files, fetch);

  const highlight = (withFiles: typeof files) =>
    highlightNativeReviewDiffVisibleRows({
      rows: data.rows,
      files: withFiles,
      scheme: "dark",
      firstRowIndex: 0,
      lastRowIndex: data.rows.length - 1,
      overscanRows: 0,
    });

  expect((await highlight(files)).tokensByRowId).toEqual(
    (await highlight(data.files)).tokensByRowId,
  );
  expect(await files[0]!.loadContents!()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
