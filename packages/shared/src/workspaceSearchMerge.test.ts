import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceFolders } from "./workspaceFolders.ts";
import { mergeFolderContentMatches, mergeFolderEntryResults } from "./workspaceSearchMerge.ts";

const folders = resolveWorkspaceFolders({
  primaryRoot: "/repo/app",
  additionalFolders: [{ path: "/repo/docs" }],
});
const [primary, docs] = folders as [(typeof folders)[number], (typeof folders)[number]];

const merge = (input: {
  primaryEntries: ReadonlyArray<string>;
  docsEntries: ReadonlyArray<string>;
  query: string;
  limit?: number;
}) =>
  mergeFolderEntryResults({
    perFolder: [
      { folder: primary, entries: input.primaryEntries.map((path) => ({ path })) },
      { folder: docs, entries: input.docsEntries.map((path) => ({ path })) },
    ],
    query: input.query,
    limit: input.limit ?? 10,
  });

describe("mergeFolderEntryResults", () => {
  it("ranks a better match from a secondary folder above a weaker primary one", () => {
    const merged = merge({
      primaryEntries: ["src/deeply/nested/other-index.ts"],
      docsEntries: ["index.ts"],
      query: "index.ts",
    });

    expect(merged.entries.map((e) => `${e.folder.label}/${e.entry.path}`)).toEqual([
      "docs/index.ts",
      "app/src/deeply/nested/other-index.ts",
    ]);
  });

  it("breaks an exact tie in favour of the primary folder", () => {
    const merged = merge({
      primaryEntries: ["src/index.ts"],
      docsEntries: ["src/index.ts"],
      query: "index.ts",
    });

    expect(merged.entries[0]?.folder.isPrimary).toBe(true);
  });

  it("keeps both folders' entries when the query is empty", () => {
    const merged = merge({
      primaryEntries: ["a.ts", "b.ts"],
      docsEntries: ["c.md"],
      query: "",
    });

    expect(merged.entries).toHaveLength(3);
  });

  it("caps the merged list rather than each folder", () => {
    // A four-folder project must not return four times as many rows as a
    // single-folder one.
    const merged = merge({
      primaryEntries: ["a.ts", "b.ts", "c.ts"],
      docsEntries: ["d.md", "e.md", "f.md"],
      query: "",
      limit: 2,
    });

    expect(merged.entries).toHaveLength(2);
    expect(merged.truncated).toBe(true);
  });

  it("propagates a folder's own truncation flag", () => {
    const merged = mergeFolderEntryResults({
      perFolder: [
        { folder: primary, entries: [{ path: "a.ts" }], truncated: true },
        { folder: docs, entries: [{ path: "b.md" }] },
      ],
      query: "",
      limit: 10,
    });

    expect(merged.truncated).toBe(true);
  });

  it("keeps upstream-only matches, ordered below locally-scored ones", () => {
    // fff can match on signals we cannot reproduce; those entries must survive
    // the merge rather than being dropped for scoring null.
    const merged = merge({
      primaryEntries: ["totally/unrelated.txt"],
      docsEntries: ["index.ts"],
      query: "index",
    });

    expect(merged.entries.map((e) => e.entry.path)).toEqual(["index.ts", "totally/unrelated.txt"]);
  });
});

describe("mergeFolderContentMatches", () => {
  it("concatenates in folder order", () => {
    const merged = mergeFolderContentMatches({
      perFolder: [
        { folder: primary, matches: ["a", "b"] },
        { folder: docs, matches: ["c"] },
      ],
      limit: 10,
    });

    expect(merged.matches.map((m) => m.match)).toEqual(["a", "b", "c"]);
    expect(merged.truncated).toBe(false);
  });

  it("stops at the limit and reports truncation", () => {
    const merged = mergeFolderContentMatches({
      perFolder: [
        { folder: primary, matches: ["a", "b"] },
        { folder: docs, matches: ["c"] },
      ],
      limit: 2,
    });

    expect(merged.matches).toHaveLength(2);
    expect(merged.truncated).toBe(true);
  });
});
