import { expect, it } from "vite-plus/test";
import { buildReviewParsedDiff } from "./reviewModel";
import { applyWorkingChangesTreeMutation } from "./workingChangesTreeState";

function file(path: string, previousPath: string | null = null) {
  const parsed = buildReviewParsedDiff(
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    path,
  );
  if (parsed.kind !== "files" || !parsed.files[0]) throw new Error("Expected a file diff");
  return { ...parsed.files[0], previousPath };
}

it("moves a folder's files to staged immediately without changing unrelated files", () => {
  const changed = file("src/one.ts");
  const another = file("src/two.ts");
  const untouched = file("tests/one.ts");
  const before = { staged: [], unstaged: [changed, another, untouched] };
  const next = applyWorkingChangesTreeMutation(before, {
    scope: "unstaged",
    paths: [changed.path, another.path],
  });
  expect(next.staged.map((f) => f.path)).toEqual(["src/one.ts", "src/two.ts"]);
  expect(next.unstaged).toEqual([untouched]);
  expect(before.unstaged).toEqual([changed, another, untouched]);
});

it("does not duplicate a partially staged file when moving its remaining changes", () => {
  const staged = file("src/one.ts");
  const unstaged = file("src/one.ts");
  const next = applyWorkingChangesTreeMutation(
    { staged: [staged], unstaged: [unstaged] },
    { scope: "unstaged", paths: [unstaged.path] },
  );
  expect(next.staged).toEqual([staged]);
  expect(next.unstaged).toEqual([]);
});

it("unstages a renamed file as a single entry including its old path", () => {
  const renamed = file("src/new.ts", "src/old.ts");
  const next = applyWorkingChangesTreeMutation(
    { staged: [renamed], unstaged: [] },
    { scope: "staged", paths: ["src/old.ts", "src/new.ts"] },
  );
  expect(next.staged).toEqual([]);
  expect(next.unstaged).toEqual([renamed]);
});

it("reverting unstaged edits preserves the same file's staged changes", () => {
  const changed = file("src/one.ts");
  const untouched = file("src/two.ts");
  const next = applyWorkingChangesTreeMutation(
    { staged: [changed], unstaged: [changed, untouched] },
    { scope: "unstaged", paths: [changed.path], revert: true },
  );
  expect(next.staged).toEqual([changed]);
  expect(next.unstaged).toEqual([untouched]);
});
