import { highlightCode } from "../../lib/highlights";

import { CheckpointRef, EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { highlightNativeReviewDiffVisibleRows } from "../diffs/nativeReviewDiffHighlighter";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff, type ReviewSectionItem } from "./reviewModel";
import {
  createReviewDiffHighlightFiles,
  reviewDiffContentsTarget,
} from "./reviewDiffHighlightFiles";

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

const section = { id: "section", title: "Section", subtitle: null, diff: null, isLoading: false };
const changesSource: ReviewDiffPreviewSource = {
  id: "branch-range",
  kind: "branch-range",
  title: "Changes",
  baseRef: "main",
  headRef: null,
  diff: "",
  diffHash: "hash",
  truncated: false,
};

it.each([
  {
    name: "a turn, from both checkpoints",
    section: {
      ...section,
      kind: "turn",
      turnSource: {
        cwd: "/repo",
        fromCheckpointRef: CheckpointRef.make("refs/t3/before"),
        toCheckpointRef: CheckpointRef.make("refs/t3/after"),
      },
    },
    request: { sourceKind: "revisions", baseRef: "refs/t3/before", headRef: "refs/t3/after" },
  },
  {
    name: "live Changes, from its own source",
    section: { ...section, kind: "branch-range", source: changesSource },
    request: { sourceKind: "branch-range", baseRef: "main", headRef: null },
  },
] satisfies ReadonlyArray<{
  name: string;
  section: ReviewSectionItem;
  request: object;
}>)(
  "highlights a hunk inside a docstring with full files for $name",
  async ({ section, request }) => {
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
    const fetch = vi.fn(async () => AsyncResult.success({ oldContents, newContents }));
    const files = createReviewDiffHighlightFiles(
      environmentId,
      reviewDiffContentsTarget(section, "/repo")!,
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
        ...request,
        changeType: "change",
        oldPath: "docs.py",
        newPath: "docs.py",
      },
    });
    const added = data.rows.find((row) => row.kind === "line" && row.change === "add")!;
    expect(result.tokensByRowId[added.id]).toEqual(
      highlightCode(newContents, "python", "dark")[15],
    );
  },
);
