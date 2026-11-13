import { highlightCode } from "../../lib/highlights";

import { CheckpointRef, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { highlightNativeReviewDiffVisibleRows } from "../diffs/nativeReviewDiffHighlighter";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "./reviewModel";
import { createReviewTurnDiffHighlightFiles } from "./reviewTurnDiffHighlightFiles";

vi.mock("react-native-nitro-modules", async () => {
  const { createWasmHighlightsModule } = await import("../../lib/highlights.testing");
  const highlights = createWasmHighlightsModule();
  return { NitroModules: { hasHybridObject: () => true, createHybridObject: () => highlights } };
});

const prose = (line: number, verb: string) =>
  `    If True and the value is not None, characters in line ${line} are ${verb} as bool.`;
const docstring = (changed: string) =>
  [
    "def escape_text(value, quote=True):",
    '    """',
    ...Array.from({ length: 20 }, (_, index) =>
      index === 13 ? prose(14, changed) : prose(index + 1, "escaped"),
    ),
    '    """',
    "    return value",
    "",
  ].join("\n");

it("highlights a turn hunk inside a docstring from both checkpoints' full files", async () => {
  const oldContents = docstring("escaped");
  const newContents = docstring("changed");
  const patch = [
    "diff --git a/docs.py b/docs.py",
    "--- a/docs.py",
    "+++ b/docs.py",
    "@@ -13,7 +13,7 @@ def escape_text(value, quote=True):",
    ...[11, 12, 13].map((line) => ` ${prose(line, "escaped")}`),
    `-${prose(14, "escaped")}`,
    `+${prose(14, "changed")}`,
    ...[15, 16, 17].map((line) => ` ${prose(line, "escaped")}`),
    "",
  ].join("\n");
  const parsed = buildReviewParsedDiff(patch, "turn:test");
  const data = buildNativeReviewDiffData(parsed);
  const environmentId = EnvironmentId.make("environment");
  const source = {
    cwd: "/repo",
    fromCheckpointRef: CheckpointRef.make("refs/t3/before"),
    toCheckpointRef: CheckpointRef.make("refs/t3/after"),
  };
  const fetch = vi.fn(async () => AsyncResult.success({ oldContents, newContents }));
  const files = createReviewTurnDiffHighlightFiles(
    environmentId,
    source,
    parsed,
    data.files,
    fetch,
  );

  const result = await highlightNativeReviewDiffVisibleRows({
    rows: data.rows,
    files,
    scheme: "dark",
    firstRowIndex: 0,
    lastRowIndex: data.rows.length - 1,
    overscanRows: 0,
  });

  expect(fetch).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      cwd: "/repo",
      sourceKind: "revisions",
      changeType: "change",
      baseRef: "refs/t3/before",
      headRef: "refs/t3/after",
      oldPath: "docs.py",
      newPath: "docs.py",
    },
  });
  const added = data.rows.find((row) => row.kind === "line" && row.change === "add")!;
  expect(result.tokensByRowId[added.id]).toEqual(highlightCode(newContents, "python", "dark")[15]);
});
