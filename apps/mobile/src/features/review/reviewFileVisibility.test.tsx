import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { buildReviewParsedDiff, type ReviewRenderableFile } from "./reviewModel";
import { useReviewFileVisibility } from "./reviewFileVisibility";

const stored = vi.hoisted(() => ({ expanded: undefined as ReadonlyArray<string> | undefined }));
vi.mock("./reviewState", () => ({
  updateReviewExpandedFileIds: (
    _threadKey: string,
    _sectionId: string,
    update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
  ) => {
    stored.expanded = update(stored.expanded);
  },
  updateReviewViewedFileIds: () => {},
}));

function patch(path: string, line: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`;
}

function files(diff: string): ReadonlyArray<ReviewRenderableFile> {
  const parsed = buildReviewParsedDiff(diff, "turn:3");
  if (parsed.kind !== "files") throw new Error("Expected structured diff");
  return parsed.files;
}

function visibility(current: ReadonlyArray<ReviewRenderableFile>) {
  let result: ReturnType<typeof useReviewFileVisibility> | undefined;
  function Probe({ report }: { report: (value: typeof result) => void }) {
    report(
      useReviewFileVisibility({
        threadKey: "thread",
        sectionId: "turn:3",
        files: current,
        cachedExpandedFileIds: stored.expanded,
        cachedViewedFileIds: undefined,
      }),
    );
    return null;
  }
  renderToStaticMarkup(<Probe report={(value) => (result = value)} />);
  return result!;
}

it("keeps files the reader left open expanded when the section's diff changes", () => {
  stored.expanded = undefined;
  const before = files(patch("a.ts", "one") + patch("b.ts", "two"));
  visibility(before).toggleExpandedFile(before[0]!.id);
  expect(visibility(before).collapsedFileIds).toEqual([before[0]!.id]);

  const after = files(patch("a.ts", "changed") + patch("b.ts", "two"));
  const collapsedPaths = visibility(after).collapsedFileIds.map(
    (id) => after.find((file) => file.id === id)!.path,
  );
  expect(collapsedPaths).not.toContain("b.ts");
});
