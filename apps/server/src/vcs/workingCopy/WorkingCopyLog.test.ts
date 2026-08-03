import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseLogEntries, readLog } from "./WorkingCopyLog.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";
import { stagePaths } from "./WorkingCopyStaging.ts";
import {
  git,
  makeTestRepository,
  WorkingCopyTestLayer,
  writeFile,
} from "./testing/workingCopyTestRepo.ts";

const FIELD = "\x1f";
const RECORD = "\x1e";

describe("parseLogEntries", () => {
  it("keeps a subject containing the pipe character intact", () => {
    const entries = parseLogEntries(
      ["a".repeat(40), "aaaaaaa", "feat: a | b | c", "Ada", "ada@x", "2020-01-01T00:00:00Z", ""]
        .join(FIELD)
        .concat(RECORD),
    );

    assert.strictEqual(entries[0]?.subject, "feat: a | b | c");
  });

  it("splits parents on spaces and yields an empty list for a root commit", () => {
    const record = (parents: string) =>
      ["a".repeat(40), "aaaaaaa", "s", "Ada", "ada@x", "2020-01-01T00:00:00Z", parents]
        .join(FIELD)
        .concat(RECORD);

    assert.deepStrictEqual(parseLogEntries(record(""))[0]?.parents, []);
    assert.deepStrictEqual(parseLogEntries(record("b".repeat(40)))[0]?.parents, ["b".repeat(40)]);
    assert.deepStrictEqual(
      parseLogEntries(record(`${"b".repeat(40)} ${"c".repeat(40)}`))[0]?.parents,
      ["b".repeat(40), "c".repeat(40)],
    );
  });

  it("ignores a trailing empty record", () => {
    const record = ["a".repeat(40), "aaaaaaa", "s", "Ada", "ada@x", "t", ""].join(FIELD);

    assert.strictEqual(parseLogEntries(`${record}${RECORD}\n`).length, 1);
  });
});

it.layer(WorkingCopyTestLayer)("readLog", (it) => {
  const commit = Effect.fn("test.commit")(function* (
    repo: { readonly cwd: string; readonly git: Parameters<typeof readLog>[0] },
    name: string,
    message: string,
  ) {
    yield* writeFile(repo.cwd, name, `${name}\n`);
    yield* stagePaths(repo.git, [name]);
    return yield* commitStaged(repo.git, message);
  });

  it.effect("answers an empty page on an empty repository instead of failing", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();

      assert.deepStrictEqual(yield* readLog(repo.git, {}), { entries: [], hasMore: false });
    }),
  );

  it.effect("reports hasMore from the limit + 1 probe, not from the page length", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      for (let index = 0; index < 3; index += 1) {
        yield* commit(repo, `f${index}.ts`, `commit ${index}`);
      }

      const exact = yield* readLog(repo.git, { limit: 3 });
      const partial = yield* readLog(repo.git, { limit: 2 });

      assert.strictEqual(exact.entries.length, 3);
      assert.strictEqual(exact.hasMore, false);
      assert.strictEqual(partial.entries.length, 2);
      assert.strictEqual(partial.hasMore, true);
    }),
  );

  it.effect("survives a subject containing a newline and one containing a pipe", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* commit(repo, "a.ts", "feat: a | b");
      // A body separated by a blank line: `%s` must stop at the subject.
      yield* commit(repo, "b.ts", "fix: second\n\nbody with\nnewlines\n");

      const page = yield* readLog(repo.git, { limit: 10 });

      assert.deepStrictEqual(
        page.entries.map((entry) => entry.subject),
        ["fix: second", "feat: a | b"],
      );
    }),
  );

  it.effect("pages by cursor without dropping the second-parent side of a merge", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* commit(repo, "base.ts", "base");
      yield* git(repo.cwd, ["checkout", "-q", "-b", "side"]);
      const sideCommit = yield* commit(repo, "side.ts", "side work");
      yield* git(repo.cwd, ["checkout", "-q", "main"]);
      yield* commit(repo, "main.ts", "main work");
      yield* git(repo.cwd, ["merge", "--no-ff", "-m", "merge side", "side"]);

      const first = yield* readLog(repo.git, { limit: 1 });
      const mergeHash = first.entries[0]?.hash ?? "";
      assert.strictEqual(first.entries[0]?.subject, "merge side");
      assert.strictEqual(first.entries[0]?.parents.length, 2);

      const rest = yield* readLog(repo.git, { limit: 10, before: mergeHash });

      // `<hash>~1` would follow the first parent only and lose "side work".
      assert.include(
        rest.entries.map((entry) => entry.subject),
        "side work",
      );
      assert.include(
        rest.entries.map((entry) => entry.hash),
        sideCommit.hash,
      );
      // The cursor commit itself is skipped exactly once.
      assert.notInclude(
        rest.entries.map((entry) => entry.hash),
        mergeHash,
      );
    }),
  );

  it.effect("searches with fixed strings, so a query containing `(` is not a regex error", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* commit(repo, "a.ts", "fix(panel): stage rows");
      yield* commit(repo, "b.ts", "chore: unrelated");

      const page = yield* readLog(repo.git, { limit: 10, grep: "fix(panel)" });

      assert.deepStrictEqual(
        page.entries.map((entry) => entry.subject),
        ["fix(panel): stage rows"],
      );
    }),
  );

  it.effect("filters by author case-insensitively", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* commit(repo, "a.ts", "one");

      const matched = yield* readLog(repo.git, { limit: 10, author: "working copy" });
      const missed = yield* readLog(repo.git, { limit: 10, author: "nobody" });

      assert.strictEqual(matched.entries.length, 1);
      assert.strictEqual(missed.entries.length, 0);
    }),
  );

  it.effect("answers an empty page for a rev that does not resolve", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      yield* commit(repo, "a.ts", "one");

      const page = yield* readLog(repo.git, { limit: 10, rev: "0".repeat(40) });

      assert.deepStrictEqual(page, { entries: [], hasMore: false });
    }),
  );

  it.effect("populates every entry field from the real repository", () =>
    Effect.gen(function* () {
      const repo = yield* makeTestRepository();
      const created = yield* commit(repo, "a.ts", "subject here");

      const page = yield* readLog(repo.git, { limit: 1 });
      const entry = page.entries[0];

      assert.strictEqual(entry?.hash, created.hash);
      assert.strictEqual(entry?.shortHash, created.shortHash);
      assert.strictEqual(entry?.authorName, "Working Copy Test");
      assert.strictEqual(entry?.authorEmail, "working-copy@test.invalid");
      // `%aI` is strict ISO 8601 with an offset.
      assert.match(entry?.authoredAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    }),
  );
});
