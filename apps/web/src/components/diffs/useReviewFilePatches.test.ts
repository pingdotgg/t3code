import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { reviewEnvironment } from "~/state/review";
import { getRenderablePatch } from "~/lib/diffRendering";

import {
  parsedPatchAtom,
  reviewFileIdentityKey,
  reviewFileIdentityKeys,
  reviewFileQueries,
} from "./useReviewFilePatches";

it("retains parsed patches across waiting updates and remounts, but reparses edits and path changes", () => {
  const source: ReviewDiffPreviewSource = {
    id: "working-tree",
    kind: "working-tree",
    title: "Working tree",
    baseRef: null,
    headRef: null,
    diff: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before\n+after\n",
    diffHash: "one",
    truncated: false,
    files: [{ path: "file.ts", previousPath: null, additions: 1, deletions: 1 }],
  };
  const raw = Atom.make(AsyncResult.success(source));
  using _query = vi.spyOn(reviewEnvironment, "diffFilePatch").mockReturnValue(raw);
  const target = {
    environmentId: EnvironmentId.make("parse-test"),
    input: {
      cacheKey: "parse-test",
      request: {
        cwd: "/workspace",
        file: { path: "file.ts", previousPath: null, sourceKind: "working-tree" },
      },
    },
  };
  const parsed = parsedPatchAtom(JSON.stringify(["dark", target]));
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  try {
    const read = () => Option.getOrThrow(AsyncResult.value(registry.get(parsed))).patch;
    const unmount = registry.mount(parsed);
    const first = read();
    registry.set(raw, AsyncResult.success(source, { waiting: true }));
    expect(read()).toBe(first);
    registry.set(
      raw,
      AsyncResult.success({ ...source, files: source.files!.map((file) => ({ ...file })) }),
    );
    expect(read()).toBe(first);
    unmount();
    for (const task of scheduled.splice(0)) task();
    const remount = registry.mount(parsed);
    expect(read()).toBe(first);
    const editedSource = { ...source, diff: source.diff.replace("+after", "+updated") };
    registry.set(raw, AsyncResult.success(editedSource));
    const edited = read();
    expect(edited).not.toBe(first);
    registry.set(
      raw,
      AsyncResult.success({
        ...editedSource,
        files: [{ ...source.files![0]!, path: "renamed.ts", previousPath: "file.ts" }],
      }),
    );
    const renamed = read();
    expect(renamed?.kind === "files" && renamed.files[0]?.name).toBe("renamed.ts");
    expect(renamed?.kind === "files" && renamed.files[0]?.prevName).toBe("file.ts");
    registry.set(
      raw,
      AsyncResult.success({
        ...editedSource,
        files: [{ ...source.files![0]!, path: "renamed.ts", previousPath: null }],
      }),
    );
    const noPreviousPath = read();
    expect(noPreviousPath?.kind === "files" && noPreviousPath.files[0]?.prevName).toBeUndefined();
    registry.set(
      raw,
      AsyncResult.success({
        ...editedSource,
        files: [...source.files!, { ...source.files![0]!, path: "other.ts" }],
      }),
    );
    const multipleStats = read();
    expect(multipleStats?.kind === "files" && multipleStats.files[0]?.name).toBe("file.ts");
    registry.set(
      raw,
      AsyncResult.success({
        ...editedSource,
        files: [{ ...source.files![0]!, path: "another.ts" }],
      }),
    );
    const singleStat = read();
    expect(singleStat?.kind === "files" && singleStat.files[0]?.name).toBe("another.ts");
    remount();
  } finally {
    registry.dispose();
  }
});

it("keeps metadata identities stable across full-preview change types without merging paired sections", () => {
  const files = [
    { path: "added.ts", previousPath: null },
    { path: "deleted.ts", previousPath: null },
    { path: "renamed.ts", previousPath: "old.ts" },
    { path: "symlink", previousPath: null },
    { path: "symlink", previousPath: null },
  ];
  const keys = reviewFileIdentityKeys(files);
  const parsed = getRenderablePatch(
    [
      "diff --git a/added.ts b/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.ts",
      "@@ -0,0 +1 @@",
      "+value",
      "diff --git a/deleted.ts b/deleted.ts",
      "deleted file mode 100644",
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-value",
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to renamed.ts",
      "diff --git a/symlink b/symlink",
      "deleted file mode 100644",
      "--- a/symlink",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-value",
      "diff --git a/symlink b/symlink",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/symlink",
      "@@ -0,0 +1 @@",
      "+target",
      "",
    ].join("\n"),
    "test",
  );

  expect(new Set(keys).size).toBe(files.length);
  expect(parsed?.kind).toBe("files");
  if (parsed?.kind !== "files") return;
  expect(parsed.files.map((file) => file.type)).toEqual([
    "new",
    "deleted",
    "rename-pure",
    "deleted",
    "new",
  ]);
  expect(reviewFileIdentityKeys(parsed.files)).toEqual(keys);
  expect(reviewFileIdentityKey({ path: "added.ts", previousPath: "added.ts" })).toBe(keys[0]);
  expect(keys[3]).not.toBe(keys[4]);
});

it("does not request bodies for a default-collapsed metadata list until find opens", () => {
  const source: ReviewDiffPreviewSource = {
    id: "working-tree",
    kind: "working-tree",
    title: "Working tree",
    baseRef: null,
    headRef: null,
    diff: "",
    diffHash: "revision",
    truncated: true,
    files: Array.from({ length: 30 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      previousPath: null,
      additions: 1,
      deletions: 1,
    })),
  };
  const input = {
    environmentId: EnvironmentId.make("local"),
    cwd: "/workspace",
    source,
    baseRef: null,
    ignoreWhitespace: false,
    previewInput: { cwd: "/workspace" },
    scope: "test",
    defaultCollapsed: true,
  };

  expect(reviewFileQueries(input)).toHaveLength(0);
  const expanded = reviewFileQueries({ ...input, collapsedFileKeys: new Set() });
  expect(expanded).toHaveLength(30);
  expect(reviewFileQueries({ ...input, loadAll: true })).toHaveLength(30);

  const selected = source.files![20]!;
  const collapsedFileKeys = new Set(source.files!.map(reviewFileIdentityKey));
  collapsedFileKeys.delete(reviewFileIdentityKey(selected));
  const revealed = reviewFileQueries({ ...input, collapsedFileKeys });
  expect(revealed.map(({ target }) => target.input.request.file.path)).toEqual([selected.path]);

  const inserted = { ...source.files![0]!, path: "000-new.ts" };
  collapsedFileKeys.add(reviewFileIdentityKey(inserted));
  expect(
    reviewFileQueries({
      ...input,
      source: { ...source, files: [inserted, ...source.files!] },
      collapsedFileKeys,
    }).map(({ target }) => target.input.request.file.path),
  ).toEqual([selected.path]);

  const pairedFiles = [
    { ...selected, path: "symlink" },
    { ...selected, path: "symlink" },
  ];
  const pairedKeys = reviewFileIdentityKeys(pairedFiles);
  expect(
    reviewFileQueries({
      ...input,
      source: { ...source, files: pairedFiles },
      collapsedFileKeys: new Set([pairedKeys[0]!]),
    }).map(({ index }) => index),
  ).toEqual([1]);
});
