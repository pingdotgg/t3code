import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkingCopyInvalidRevisionError } from "@t3tools/contracts";
import { LOG_FIELD_SEPARATOR } from "./commands.ts";
import { parseCommitRefs, parseNameStatusZ, readCommitDetail } from "./WorkingCopyCommitDetail.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import {
  git,
  makeTestRepository,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

const z = (...fields: ReadonlyArray<string>) => `${fields.join("\0")}\0`;

describe("parseNameStatusZ", () => {
  it("reads a plain entry", () => {
    assert.deepStrictEqual(parseNameStatusZ(z("M", "src/a.ts")), [
      { path: "src/a.ts", change: "modified" },
    ]);
  });

  it("reads a rename's three fields and keys by the new path", () => {
    assert.deepStrictEqual(parseNameStatusZ(z("R096", "old.ts", "new.ts")), [
      { path: "new.ts", change: "renamed", oldPath: "old.ts" },
    ]);
  });

  it("keeps parsing correctly after a rename consumed an extra field", () => {
    assert.deepStrictEqual(parseNameStatusZ(z("R100", "old.ts", "new.ts", "A", "added.ts")), [
      { path: "new.ts", change: "renamed", oldPath: "old.ts" },
      { path: "added.ts", change: "added" },
    ]);
  });

  it("folds an unknown status letter onto modified", () => {
    assert.deepStrictEqual(parseNameStatusZ(z("X", "weird.ts")), [
      { path: "weird.ts", change: "modified" },
    ]);
  });
});

describe("parseCommitRefs", () => {
  const line = (objectName: string, dereferenced: string, short: string, full: string) =>
    [objectName, dereferenced, short, full].join(LOG_FIELD_SEPARATOR);

  it("keys an annotated tag by the commit it dereferences to, not by the tag object", () => {
    const tagObject = "f".repeat(40);
    const commit = "a".repeat(40);

    const refs = parseCommitRefs(line(tagObject, commit, "v1.0.0", "refs/tags/v1.0.0"));

    assert.deepStrictEqual(refs.get(commit), [{ name: "v1.0.0", kind: "tag" }]);
    assert.isUndefined(refs.get(tagObject));
  });

  it("classifies branches, remotes and tags", () => {
    const commit = "a".repeat(40);
    const refs = parseCommitRefs(
      [
        line(commit, "", "main", "refs/heads/main"),
        line(commit, "", "origin/main", "refs/remotes/origin/main"),
        line(commit, "", "v1", "refs/tags/v1"),
      ].join("\n"),
    );

    assert.deepStrictEqual(refs.get(commit), [
      { name: "main", kind: "branch" },
      { name: "origin/main", kind: "remote" },
      { name: "v1", kind: "tag" },
    ]);
  });
});

it.layer(WorkingCopyTestLayer)("readCommitDetail", (it) => {
  it.effect("reads subject, body, files, stats and the HEAD badge", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* writeFile(repo.cwd, "a.ts", "one\ntwo\n");
      yield* writeFile(repo.cwd, "b.ts", "new file\n");
      yield* stagePaths(repo.git, ["a.ts", "b.ts"]);
      const created = yield* commitStaged(
        repo.git,
        "feat: thing\n\nbody line one\nbody line two\n",
      );

      const detail = yield* readCommitDetail(repo.git, created.hash);

      assert.strictEqual(detail.hash, created.hash);
      assert.strictEqual(detail.subject, "feat: thing");
      assert.strictEqual(detail.body, "body line one\nbody line two");
      assert.strictEqual(detail.authorName, "Working Copy Test");
      assert.deepStrictEqual(
        detail.files.map((file) => [file.path, file.change]),
        [
          ["a.ts", "modified"],
          ["b.ts", "added"],
        ],
      );
      assert.strictEqual(detail.insertions, 2);
      assert.strictEqual(detail.deletions, 0);
      assert.deepStrictEqual(detail.refs, [
        { name: "HEAD", kind: "head" },
        { name: "main", kind: "branch" },
      ]);
    }),
  );

  it.effect("shows a file list for a merge commit thanks to --first-parent", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "base.ts", "base\n");
      yield* stagePaths(repo.git, ["base.ts"]);
      yield* commitStaged(repo.git, "base");

      yield* git(repo.cwd, ["checkout", "-q", "-b", "side"]);
      yield* writeFile(repo.cwd, "side.ts", "side\n");
      yield* stagePaths(repo.git, ["side.ts"]);
      yield* commitStaged(repo.git, "side");

      yield* git(repo.cwd, ["checkout", "-q", "main"]);
      yield* git(repo.cwd, ["merge", "--no-ff", "-m", "merge side", "side"]);
      const mergeHash = (yield* git(repo.cwd, ["rev-parse", "HEAD"])).trim();

      const detail = yield* readCommitDetail(repo.git, mergeHash);

      assert.strictEqual(detail.subject, "merge side");
      assert.strictEqual(detail.parents.length, 2);
      assert.deepStrictEqual(
        detail.files.map((file) => file.path),
        ["side.ts"],
      );
    }),
  );

  it.effect("attaches an annotated tag to the commit it points at", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* writeFile(repo.cwd, "a.ts", "one\n");
      yield* stagePaths(repo.git, ["a.ts"]);
      const created = yield* commitStaged(repo.git, "base");
      yield* git(repo.cwd, ["tag", "-a", "v1.0.0", "-m", "release"]);

      const detail = yield* readCommitDetail(repo.git, created.hash);

      assert.include(
        detail.refs.map((ref) => `${ref.kind}:${ref.name}`),
        "tag:v1.0.0",
      );
    }),
  );

  it.effect("refuses a revision expression before it reaches git", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      const failure = yield* readCommitDetail(repo.git, "HEAD~1").pipe(Effect.flip);

      assert.instanceOf(failure, WorkingCopyInvalidRevisionError);
    }),
  );
});
