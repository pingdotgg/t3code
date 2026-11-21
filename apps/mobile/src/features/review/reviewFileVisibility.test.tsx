import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { buildReviewParsedDiff, type ReviewRenderableFile } from "./reviewModel";
import { useReviewFileVisibility } from "./reviewFileVisibility";

const stored = vi.hoisted(() => ({
  expanded: undefined as ReadonlyArray<string> | undefined,
  viewed: undefined as ReadonlyArray<string> | undefined,
}));
vi.mock("./reviewState", () => ({
  updateReviewExpandedFileIds: (
    _threadKey: string,
    _sectionId: string,
    update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
  ) => {
    stored.expanded = update(stored.expanded);
  },
  updateReviewViewedFileIds: (
    _threadKey: string,
    _sectionId: string,
    update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
  ) => {
    stored.viewed = update(stored.viewed);
  },
}));

function patch(path: string, line: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`;
}

function files(diff: string): ReadonlyArray<ReviewRenderableFile> {
  const parsed = buildReviewParsedDiff(diff, "turn:3");
  if (parsed.kind !== "files") throw new Error("Expected structured diff");
  return parsed.files;
}

function visibility(
  current: ReadonlyArray<ReviewRenderableFile>,
  section: ReadonlyArray<ReviewRenderableFile> = current,
) {
  let result: ReturnType<typeof useReviewFileVisibility> | undefined;
  function Probe({ report }: { report: (value: typeof result) => void }) {
    report(
      useReviewFileVisibility({
        threadKey: "thread",
        sectionId: "turn:3",
        files: current,
        sectionFiles: section,
        cachedExpandedFileIds: stored.expanded,
        cachedViewedFileIds: stored.viewed,
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

it("folds only the selected entry when a file becomes a symlink", () => {
  stored.expanded = undefined;
  const current = files(
    "diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" +
      "diff --git a/a.ts b/a.ts\nnew file mode 120000\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+b.ts\n\\ No newline at end of file\n",
  );
  expect(current).toHaveLength(2);
  visibility(current).toggleExpandedFile(current[0]!.id);
  expect(visibility(current).collapsedFileIds).toEqual([current[0]!.id]);
});

it("keeps the marks of files a repository filter hides", () => {
  stored.expanded = undefined;
  stored.viewed = undefined;
  const all = files(
    patch("web/a.ts", "one") + patch("api/b.ts", "two") + patch("api/c.ts", "three"),
  );
  const [webFile, apiFile, otherApiFile] = all;
  visibility(all).toggleViewedFile(webFile!.id);

  const apiOnly = all.slice(1);
  visibility(apiOnly).toggleViewedFile(apiFile!.id);
  visibility(apiOnly).toggleExpandedFile(otherApiFile!.id);

  expect(visibility(all).viewedFileIds).toEqual([webFile!.id, apiFile!.id]);
  expect(visibility(all).collapsedFileIds).toEqual(all.map((file) => file.id));
  visibility(apiOnly).toggleViewedFile(apiFile!.id);
  expect(visibility(all).viewedFileIds).toEqual([webFile!.id]);

  stored.expanded = undefined;
  visibility(apiOnly, all).toggleExpandedFile(apiFile!.id);
  expect(visibility(all).collapsedFileIds).toEqual([apiFile!.id]);
  stored.expanded = undefined;
  stored.viewed = undefined;
  visibility(apiOnly, all).toggleViewedFile(otherApiFile!.id);
  expect(visibility(all).collapsedFileIds).toEqual([otherApiFile!.id]);
});
