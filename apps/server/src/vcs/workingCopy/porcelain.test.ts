import { assert, describe, it } from "@effect/vitest";

import {
  applyNumstat,
  parseAheadBehind,
  parseNumstatZ,
  parsePorcelainV1Z,
  unquoteGitPath,
} from "./porcelain.ts";

/** `-z` records are NUL-terminated, so a fixture is a joined list of fields. */
const z = (...fields: ReadonlyArray<string>) => `${fields.join("\0")}\0`;

describe("parsePorcelainV1Z", () => {
  it("yields two rows for MM — the panel's `partial` chip is derived from that", () => {
    const files = parsePorcelainV1Z(z("MM src/a.ts"));

    assert.deepStrictEqual(files, [
      { path: "src/a.ts", area: "staged", change: "modified" },
      { path: "src/a.ts", area: "unstaged", change: "modified" },
    ]);
  });

  it("yields one conflicted row for UU, never staged + unstaged", () => {
    const files = parsePorcelainV1Z(z("UU src/conflict.ts"));

    assert.deepStrictEqual(files, [
      { path: "src/conflict.ts", area: "conflicted", change: "unmerged" },
    ]);
  });

  it("yields one conflicted row for AA and for DD", () => {
    assert.deepStrictEqual(parsePorcelainV1Z(z("AA both-added.ts")), [
      { path: "both-added.ts", area: "conflicted", change: "unmerged" },
    ]);
    assert.deepStrictEqual(parsePorcelainV1Z(z("DD both-deleted.ts")), [
      { path: "both-deleted.ts", area: "conflicted", change: "unmerged" },
    ]);
  });

  it("treats a U on either side as conflicted", () => {
    assert.deepStrictEqual(parsePorcelainV1Z(z("AU added-by-us.ts")), [
      { path: "added-by-us.ts", area: "conflicted", change: "unmerged" },
    ]);
    assert.deepStrictEqual(parsePorcelainV1Z(z("UD deleted-by-them.ts")), [
      { path: "deleted-by-them.ts", area: "conflicted", change: "unmerged" },
    ]);
  });

  it("consumes the next NUL field as oldPath for R, and again for the following record", () => {
    const files = parsePorcelainV1Z(z("R  new/name.ts", "old/name.ts", " M other.ts"));

    assert.deepStrictEqual(files, [
      { path: "new/name.ts", area: "staged", change: "renamed", oldPath: "old/name.ts" },
      { path: "other.ts", area: "unstaged", change: "modified" },
    ]);
  });

  it("keeps oldPath on the staged side of an RM and not on the unstaged side", () => {
    const files = parsePorcelainV1Z(z("RM new.ts", "old.ts"));

    assert.deepStrictEqual(files, [
      { path: "new.ts", area: "staged", change: "renamed", oldPath: "old.ts" },
      { path: "new.ts", area: "unstaged", change: "modified" },
    ]);
  });

  it("puts an untracked file in the unstaged group with change `untracked`", () => {
    assert.deepStrictEqual(parsePorcelainV1Z(z("?? fresh.ts")), [
      { path: "fresh.ts", area: "unstaged", change: "untracked" },
    ]);
  });

  it("skips ignored entries", () => {
    assert.deepStrictEqual(parsePorcelainV1Z(z("!! dist/bundle.js")), []);
  });

  it("maps every status letter it knows and folds unknown letters onto modified", () => {
    const files = parsePorcelainV1Z(z("A  added.ts", "D  deleted.ts", "T  type.ts", "X  weird.ts"));

    assert.deepStrictEqual(
      files.map((file) => file.change),
      ["added", "deleted", "typechange", "modified"],
    );
  });

  it("ignores an empty status (a clean tree)", () => {
    assert.deepStrictEqual(parsePorcelainV1Z(""), []);
  });
});

describe("unquoteGitPath", () => {
  it("passes an unquoted path through untouched", () => {
    assert.strictEqual(unquoteGitPath("src/a.ts"), "src/a.ts");
  });

  it("decodes octal escapes back into UTF-8", () => {
    assert.strictEqual(unquoteGitPath('"caf\\303\\251.txt"'), "café.txt");
  });

  it("decodes C escapes", () => {
    assert.strictEqual(unquoteGitPath('"a\\tb\\nc.txt"'), "a\tb\nc.txt");
  });

  it("decodes an escaped quote and backslash", () => {
    assert.strictEqual(unquoteGitPath('"say \\"hi\\".txt"'), 'say "hi".txt');
  });
});

describe("parseNumstatZ", () => {
  it("parses plain entries", () => {
    assert.deepStrictEqual(parseNumstatZ(z("3\t1\tsrc/a.ts", "0\t7\tsrc/b.ts")), [
      { path: "src/a.ts", insertions: 3, deletions: 1 },
      { path: "src/b.ts", insertions: 0, deletions: 7 },
    ]);
  });

  it("reports a binary file as having no counts, not zero counts", () => {
    assert.deepStrictEqual(parseNumstatZ(z("-\t-\tlogo.png")), [{ path: "logo.png" }]);
  });

  it("reads a rename's three-field form and keys by the new path", () => {
    assert.deepStrictEqual(parseNumstatZ(z("2\t2\t", "old.ts", "new.ts")), [
      { path: "new.ts", insertions: 2, deletions: 2 },
    ]);
  });
});

describe("applyNumstat", () => {
  it("attaches counts per area, so an MM path gets a different pair on each row", () => {
    const files = applyNumstat(
      [
        { path: "a.ts", area: "staged", change: "modified" },
        { path: "a.ts", area: "unstaged", change: "modified" },
      ],
      [{ path: "a.ts", insertions: 10, deletions: 0 }],
      [{ path: "a.ts", insertions: 1, deletions: 2 }],
    );

    assert.deepStrictEqual(files, [
      { path: "a.ts", area: "staged", change: "modified", insertions: 10, deletions: 0 },
      { path: "a.ts", area: "unstaged", change: "modified", insertions: 1, deletions: 2 },
    ]);
  });

  it("leaves untracked and conflicted rows without counts", () => {
    const files = applyNumstat(
      [
        { path: "fresh.ts", area: "unstaged", change: "untracked" },
        { path: "boom.ts", area: "conflicted", change: "unmerged" },
      ],
      [],
      [
        { path: "fresh.ts", insertions: 5, deletions: 0 },
        { path: "boom.ts", insertions: 5, deletions: 5 },
      ],
    );

    assert.deepStrictEqual(files, [
      { path: "fresh.ts", area: "unstaged", change: "untracked" },
      { path: "boom.ts", area: "conflicted", change: "unmerged" },
    ]);
  });
});

describe("parseAheadBehind", () => {
  it("reads the tab-separated counts", () => {
    assert.deepStrictEqual(parseAheadBehind("2\t5\n"), { ahead: 2, behind: 5 });
  });

  it("returns no numbers at all for a gone or absent upstream", () => {
    // Not `{ahead: 0, behind: 0}` — that renders as "in sync", which is a
    // different and wrong statement.
    assert.deepStrictEqual(parseAheadBehind(null), {});
  });
});
