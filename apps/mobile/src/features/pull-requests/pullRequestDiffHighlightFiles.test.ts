import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import {
  getNativeReviewDiffHighlighter,
  highlightNativeReviewDiffVisibleRows,
} from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff, ReviewRenderableFile } from "../review/reviewModel";
import { createPullRequestDiffHighlightFiles } from "./pullRequestDiffHighlightFiles";

const target = {
  environmentId: EnvironmentId.make("remote-environment"),
  input: {
    projectId: ProjectId.make("project"),
    repository: "org/repo",
    number: 23,
    host: "forge.example.com",
  },
};

function file(id: string, path: string, previousPath: string | null): ReviewRenderableFile {
  return {
    id,
    path,
    previousPath,
    cacheKey: id,
    changeType: previousPath ? "rename-changed" : "change",
    additions: 1,
    deletions: 1,
    languageHint: "typescript",
    additionLines: [],
    deletionLines: [],
    rows: [],
  };
}

function setup() {
  const parsed = {
    kind: "files",
    fileCount: 2,
    additions: 2,
    deletions: 2,
    notice: null,
    files: [file("selected", "renderer.ts", "old-renderer.ts"), file("unseen", "unseen.ts", null)],
  } satisfies ReviewParsedDiff;
  const files: NativeReviewDiffFile[] = parsed.files.map((file) => ({
    id: file.id,
    path: file.path,
    language: "typescript",
    additions: 1,
    deletions: 1,
  }));
  return { parsed, files };
}

it("loads only the selected PR file using its remote target, commit, and rename paths", async () => {
  const { parsed, files } = setup();
  const contents = {
    oldContents: "/* Previous renderer\nconst removed = 1;\n*/",
    newContents: "const heading = `Current renderer\nWelcome to the workspace.\n`;",
  };
  const fetch = vi.fn(async () => AsyncResult.success(contents));
  const loaded = createPullRequestDiffHighlightFiles(
    { target, commit: "abc123" },
    parsed,
    files,
    fetch,
  );
  expect(fetch).not.toHaveBeenCalled();
  const rows = [
    {
      kind: "line" as const,
      id: "removed",
      fileId: "selected",
      change: "delete" as const,
      oldLineNumber: 2,
      newLineNumber: null,
      content: "const removed = 1;",
    },
    {
      kind: "line" as const,
      id: "added",
      fileId: "selected",
      change: "add" as const,
      oldLineNumber: null,
      newLineNumber: 2,
      content: "Welcome to the workspace.",
    },
    {
      kind: "line" as const,
      id: "unseen",
      fileId: "unseen",
      change: "add" as const,
      oldLineNumber: null,
      newLineNumber: 1,
      content: "export const unseen = true;",
    },
  ];
  const result = await highlightNativeReviewDiffVisibleRows({
    rows,
    files: loaded,
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: 1,
    overscanRows: 0,
  });
  expect(fetch.mock.calls).toEqual([
    [
      {
        ...target,
        input: {
          ...target.input,
          commit: "abc123",
          changeType: "rename-changed",
          oldPath: "old-renderer.ts",
          newPath: "renderer.ts",
        },
      },
    ],
  ]);
  const highlighter = await getNativeReviewDiffHighlighter("javascript");
  const options = { lang: "typescript" as const, theme: "t3-pierre-dark" };
  expect(result.tokensByRowId.removed).toEqual(
    (await highlighter.tokenize(contents.oldContents, options))[1],
  );
  expect(result.tokensByRowId.added).toEqual(
    (await highlighter.tokenize(contents.newContents, options))[1],
  );
  expect(result.tokensByRowId.unseen).toBeUndefined();
  expect(await loaded[0]!.loadContents!()).toBe(contents);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not reuse source from another diff snapshot", async () => {
  const { parsed, files } = setup();
  const fetch = vi.fn(async () =>
    AsyncResult.success({ oldContents: "", newContents: "const current = true;" }),
  );
  const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch);
  const second = createPullRequestDiffHighlightFiles({ target }, { ...parsed }, files, fetch);
  await first[0]!.loadContents!();
  await second[0]!.loadContents!();
  expect(fetch).toHaveBeenCalledTimes(2);
});
