import { highlightCode } from "../../lib/highlights";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import { highlightNativeReviewDiffVisibleRows } from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import type { ReviewParsedDiff, ReviewRenderableFile } from "../review/reviewModel";
import { combinePullRequestDiffPages } from "./pullRequestDiffPages";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  createPullRequestDiffHighlightCache,
  createPullRequestDiffHighlightFiles,
} from "./pullRequestDiffHighlightFiles";

vi.mock("expo", async () => {
  const { createWasmHighlightsModule } = await import("../../lib/highlights.testing");
  return { requireOptionalNativeModule: () => createWasmHighlightsModule() };
});

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
  expect(result.tokensByRowId.removed).toEqual(
    highlightCode(contents.oldContents, "typescript", "dark")[1],
  );
  expect(result.tokensByRowId.added).toEqual(
    highlightCode(contents.newContents, "typescript", "dark")[1],
  );
  expect(result.tokensByRowId.unseen).toBeUndefined();
  expect(await loaded[0]!.loadContents!()).toBe(contents);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([null, "Some file contents are unavailable"])(
  "retains fetched and unavailable source when another diff page is appended (notice: %s)",
  async (notice) => {
    const { parsed, files } = setup();
    const contents = { oldContents: "before", newContents: "after" };
    const fetch = vi.fn(async ({ input }: { input: { newPath: string } }) => {
      if (input.newPath === "unseen.ts") throw { reason: "unsupported" };
      return AsyncResult.success(contents);
    });
    const cache = createPullRequestDiffHighlightCache();
    const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch, cache);
    expect(await first[0]!.loadContents!()).toBe(contents);
    expect(await first[1]!.loadContents!()).toBeNull();
    const appended = file("appended", "appended.ts", null);
    const next = createPullRequestDiffHighlightFiles(
      { target },
      { ...parsed, files: [...parsed.files, appended], fileCount: 3, notice },
      [...files, { ...files[1]!, id: appended.id, path: appended.path }],
      fetch,
      cache,
    );
    expect(await next[0]!.loadContents!()).toBe(contents);
    expect(await next[1]!.loadContents!()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("does not reuse source from another diff snapshot", async () => {
  const { parsed, files } = setup();
  const fetch = vi.fn(async () =>
    AsyncResult.success({ oldContents: "", newContents: "const current = true;" }),
  );
  const cache = createPullRequestDiffHighlightCache();
  const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch, cache);
  const second = createPullRequestDiffHighlightFiles(
    { target },
    { ...parsed, files: parsed.files.map((file) => ({ ...file })) },
    files,
    fetch,
    cache,
  );
  await first[0]!.loadContents!();
  await second[0]!.loadContents!();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  [
    "environment",
    { target: { ...target, environmentId: EnvironmentId.make("other") }, commit: "abc" },
  ],
  [
    "project",
    {
      target: { ...target, input: { ...target.input, projectId: ProjectId.make("other") } },
      commit: "abc",
    },
  ],
  [
    "repository",
    { target: { ...target, input: { ...target.input, repository: "other/repo" } }, commit: "abc" },
  ],
  ["PR", { target: { ...target, input: { ...target.input, number: 24 } }, commit: "abc" }],
  [
    "host",
    { target: { ...target, input: { ...target.input, host: "other.example.com" } }, commit: "abc" },
  ],
  ["commit", { target, commit: "def" }],
  ["unpinned commit", { target }],
])("isolates retained file objects after changing the %s", async (_name, source) => {
  const { parsed, files } = setup();
  const cache = createPullRequestDiffHighlightCache();
  const previous = { oldContents: "", newContents: "previous" };
  const current = { oldContents: "", newContents: "current" };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(AsyncResult.success(previous))
    .mockResolvedValueOnce(AsyncResult.success(current));
  const first = createPullRequestDiffHighlightFiles(
    { target, commit: "abc" },
    parsed,
    files,
    fetch,
    cache,
  );
  expect(await first[0]!.loadContents!()).toBe(previous);
  const second = createPullRequestDiffHighlightFiles(source, parsed, files, fetch, cache);
  expect(await second[0]!.loadContents!()).toBe(current);
  expect(await first[0]!.loadContents!()).toBe(previous);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not reuse a replaced later-page file with the same ID", async () => {
  const { parsed, files } = setup();
  const cache = createPullRequestDiffHighlightCache();
  const previous = { oldContents: "", newContents: "previous" };
  const current = { oldContents: "", newContents: "current" };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(AsyncResult.success(previous))
    .mockResolvedValueOnce(AsyncResult.success(current));
  const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch, cache);
  expect(await first[1]!.loadContents!()).toBe(previous);
  const second = createPullRequestDiffHighlightFiles(
    { target },
    { ...parsed, files: [parsed.files[0]!, { ...parsed.files[1]! }] },
    files,
    fetch,
    cache,
  );
  expect(await second[1]!.loadContents!()).toBe(current);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(["permanent", "transient"])(
  "does not reuse a replaced later-page file's %s failure with the same ID",
  async (failure) => {
    const { parsed, files } = setup();
    const cache = createPullRequestDiffHighlightCache();
    const contents = { oldContents: "", newContents: "current" };
    const fetch = vi.fn(async () => AsyncResult.success(contents));
    const error = failure === "permanent" ? { reason: "unsupported" } : new Error("Offline");
    fetch.mockRejectedValueOnce(error);
    if (failure === "transient") fetch.mockRejectedValueOnce(error);
    const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch, cache);
    if (failure === "transient") await expect(first[1]!.loadContents!()).rejects.toThrow("Offline");
    expect(await first[1]!.loadContents!()).toBeNull();
    const second = createPullRequestDiffHighlightFiles(
      { target },
      { ...parsed, files: [parsed.files[0]!, { ...parsed.files[1]! }] },
      files,
      fetch,
      cache,
    );
    expect(await second[1]!.loadContents!()).toBe(contents);
    expect(await first[1]!.loadContents!()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(failure === "permanent" ? 2 : 3);
  },
);

it("does not reuse reconstructed source after an appended page makes completeness uncertain", async () => {
  const { parsed, files } = setup();
  const cache = createPullRequestDiffHighlightCache();
  const reconstructed = { oldContents: "", newContents: "reconstructed" };
  const authoritative = { oldContents: "", newContents: "authoritative" };
  parsed.files[0] = { ...parsed.files[0]!, completePatchSource: () => reconstructed };
  const fetch = vi.fn(async () => AsyncResult.success(authoritative));
  const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch, cache);
  expect(await first[0]!.loadContents!()).toBe(reconstructed);
  const next = createPullRequestDiffHighlightFiles(
    { target },
    { ...parsed, notice: "Some file contents are unavailable" },
    files,
    fetch,
    cache,
  );
  expect(await next[0]!.loadContents!()).toBe(authoritative);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  ["characters", 2, 4_500_000],
  ["file count", 5, 1],
])(
  "shares the source cache's aggregate %s budget across appended pages",
  async (_name, count, size) => {
    const { parsed, files } = setup();
    const cache = createPullRequestDiffHighlightCache();
    const contents = { oldContents: "", newContents: "x".repeat(size) };
    const fetch = vi.fn(async () => AsyncResult.success(contents));
    const first = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch, cache);
    expect(await first[0]!.loadContents!()).toBe(contents);
    let next = first;
    for (let i = 1; i < count; i++) {
      const appended = file(`page-${i}`, `page-${i}.ts`, null);
      parsed.files.push(appended);
      files.push({ ...files[0]!, id: appended.id, path: appended.path });
      next = createPullRequestDiffHighlightFiles(
        { target },
        { ...parsed },
        [...files],
        fetch,
        cache,
      );
      expect(await next.at(-1)!.loadContents!()).toBe(contents);
    }
    expect(fetch).toHaveBeenCalledTimes(count);
    expect(await next[0]!.loadContents!()).toBe(contents);
    expect(fetch).toHaveBeenCalledTimes(count + 1);
  },
);

function addedPatch(body: string, header = "@@ -0,0 +1,2 @@") {
  return `diff --git a/file.c b/file.c\nnew file mode 100644\n--- /dev/null\n+++ b/file.c\n${header}\n${body}`;
}

function loadPatch(patch: string, truncated = false) {
  const parsed = combinePullRequestDiffPages(
    [{ cursor: null, result: { patch, truncated, nextCursor: null } }],
    new WeakMap(),
    "complete-source",
    sourceControlClients.get("github").changeRequest,
  );
  if (parsed.kind !== "files") throw new Error("Expected parsed files");
  const files = parsed.files.map((file) => ({
    id: file.id,
    path: file.path,
    language: "c" as const,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const authoritative = { oldContents: "provider old", newContents: "provider new" };
  const fetch = vi.fn(async () => AsyncResult.success(authoritative));
  const loaded = createPullRequestDiffHighlightFiles({ target }, parsed, files, fetch);
  return { loaded, fetch, authoritative };
}

it.each([0, 1])(
  "loads a complete 100k-line addition with empty-side start %s beyond the RPC cap",
  async (emptyStart) => {
    const source = "/* generated C */ int value = 1;\n".repeat(100_000);
    const body = source.replace(/^/gm, "+").slice(0, -1);
    const { loaded, fetch } = loadPatch(addedPatch(body, `@@ -${emptyStart},0 +1,100000 @@`));
    expect(source.length).toBeGreaterThan(1_048_576);
    const contents = await loaded[0]!.loadContents!();
    expect(contents?.oldContents).toBe("");
    expect(contents?.newContents.length).toBe(source.length);
    expect(contents?.newContents === source).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ["LF", "+first\n+last\n", "first\nlast\n"],
  ["CRLF", "+first\r\n+last\r\n", "first\r\nlast\r\n"],
  ["missing EOF newline", "+first\r\n+last\n\\ No newline at end of file\n", "first\r\nlast"],
  ["final bare CR", "+first\r\n+last\r\n\\ No newline at end of file\n", "first\r\nlast\r"],
])("preserves %s for complete additions and deletions", async (_name, body, source) => {
  for (const emptyStart of [0, 1]) {
    const added = addedPatch(body, `@@ -${emptyStart},0 +1,2 @@`);
    const deleted = added
      .replace("new file mode", "deleted file mode")
      .replace("--- /dev/null\n+++ b/file.c", "--- a/file.c\n+++ /dev/null")
      .replace(`@@ -${emptyStart},0 +1,2 @@`, `@@ -1,2 +${emptyStart},0 @@`);
    const deletionPatch = deleted.replace(body, body.replace(/\+/g, "-"));
    for (const [patch, expected] of [
      [added, { oldContents: "", newContents: source }],
      [deletionPatch, { oldContents: source, newContents: "" }],
    ] as const) {
      const { loaded, fetch } = loadPatch(patch);
      expect(await loaded[0]!.loadContents!()).toEqual(expected);
      expect(fetch).not.toHaveBeenCalled();
    }
  }
});

it.each([
  ["too few lines", addedPatch("+first\n", "@@ -0,0 +1,2 @@")],
  ["too many lines", addedPatch("+first\n+last\n", "@@ -0,0 +1 @@")],
  ["zero repaired count", addedPatch("+first\n+last\n", "@@ -0,0 +1,0 @@")],
  ["unterminated patch line", addedPatch("+first\n+last")],
  ["missing count", addedPatch("+first\n+last\n", "@@ -0,0 +1, @@")],
  ["gap", addedPatch("+first\n+last\n", "@@ -0,0 +2,2 @@")],
  ["invalid empty-side start", addedPatch("+first\n+last\n", "@@ -2,0 +1,2 @@")],
  ["converted underfull hunk", addedPatch("+first\n", "@@ -1,0 +1,2 @@")],
  ["converted overfull hunk", addedPatch("+first\n+last\n", "@@ -1,0 +1 @@")],
  ["converted nonempty old side", addedPatch("+first\n+last\n", "@@ -1,1 +1,2 @@")],
  ["context", addedPatch(" first\n+last\n", "@@ -1 +1,2 @@")],
  ["mixed sides", addedPatch("-first\n+last\n", "@@ -1 +1 @@")],
  ["second hunk", addedPatch("+first\n@@ -0,0 +2 @@\n+last\n", "@@ -0,0 +1 @@")],
  ["early EOF marker", addedPatch("+first\n\\ No newline at end of file\n+last\n")],
  ["unknown marker", addedPatch("+first\n+last\n\\ unknown\n")],
  ["trailing garbage", addedPatch("+first\n+last\nignored\n")],
  ["submodule", addedPatch("+first\n+last\n").replace("100644", "160000")],
  [
    "binary",
    addedPatch("+first\n+last\n").replace("--- /dev/null", "Binary files differ\n--- /dev/null"),
  ],
  ["changed", addedPatch("+first\n+last\n").replace("new file mode 100644\n", "")],
  [
    "rename",
    addedPatch("+first\n+last\n").replace(
      "new file mode 100644",
      "similarity index 50%\nrename from old.c\nrename to file.c",
    ),
  ],
  ["truncation marker", addedPatch("+first\n+last\n\n[truncated]\n")],
])("uses authoritative RPC source when completeness is unproven: %s", async (_name, patch) => {
  const { loaded, fetch, authoritative } = loadPatch(patch);
  expect(await loaded[0]!.loadContents!()).toBe(authoritative);
  expect(fetch).toHaveBeenCalledOnce();
});

it("rejects a complete-looking patch when the provider marks any page truncated", async () => {
  const { loaded, fetch, authoritative } = loadPatch(addedPatch("+first\n+last\n"), true);
  expect(await loaded[0]!.loadContents!()).toBe(authoritative);
  expect(fetch).toHaveBeenCalledOnce();
});
