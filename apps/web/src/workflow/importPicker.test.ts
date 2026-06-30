import { describe, expect, it } from "vite-plus/test";

import {
  applyPickerFilters,
  defaultChecked,
  groupSelectedBySource,
  isUrl,
  selectionKey,
  type FilterState,
} from "./importPicker.ts";

const row = (over: Partial<Parameters<typeof applyPickerFilters>[0][number]> = {}) => ({
  provider: "github" as const,
  sourceId: "s1",
  externalId: "1",
  displayRef: "#1",
  title: "Fix bug",
  container: "a/b",
  url: "https://github.com/a/b/issues/1",
  assignees: ["alice"],
  lifecycle: "open" as const,
  mappedTicketId: null,
  mappedLane: null,
  ...over,
});

describe("applyPickerFilters", () => {
  const base: FilterState = { search: "", assignedToMe: false, hideTasked: false };

  it("hide tasked drops mapped rows", () => {
    const out = applyPickerFilters(
      [row({ mappedTicketId: "t1" as any }), row({ externalId: "2" })],
      { ...base, hideTasked: true },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("assigned-to-me uses the row's source viewer aliases", () => {
    const out = applyPickerFilters(
      [row({ assignees: ["alice"] }), row({ externalId: "2", assignees: ["bob"] })],
      { ...base, assignedToMe: true },
      { s1: { id: "alice", aliases: ["alice"] } },
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("assigned-to-me disabled for a source with null viewer (drops those rows)", () => {
    const out = applyPickerFilters([row({})], { ...base, assignedToMe: true }, { s1: null });
    expect(out.map((r) => r.externalId)).toEqual([]);
  });

  it("search matches title and displayRef, case-insensitive", () => {
    const out = applyPickerFilters(
      [row({ title: "Fix bug" }), row({ externalId: "2", title: "Other" })],
      { ...base, search: "fix" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("a pasted URL filters to the row whose url matches", () => {
    const out = applyPickerFilters(
      [
        row({ url: "https://github.com/a/b/issues/1" }),
        row({ externalId: "2", url: "https://github.com/a/b/issues/2" }),
      ],
      { ...base, search: "https://github.com/a/b/issues/2" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("a pasted URL matches exactly, not as a prefix (issues/1 not issues/10)", () => {
    const out = applyPickerFilters(
      [
        row({ url: "https://github.com/a/b/issues/1" }),
        row({ externalId: "10", url: "https://github.com/a/b/issues/10" }),
      ],
      { ...base, search: "https://github.com/a/b/issues/1" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("combines hideTasked and search", () => {
    const out = applyPickerFilters(
      [
        row({ externalId: "1", title: "Fix bug", mappedTicketId: "t1" as any }),
        row({ externalId: "2", title: "Fix bug" }),
        row({ externalId: "3", title: "Other" }),
      ],
      { ...base, hideTasked: true, search: "fix" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("returns [] for empty input", () => {
    expect(applyPickerFilters([], base, {})).toEqual([]);
  });
});

describe("selection + grouping", () => {
  it("defaultChecked: closed/mapped unchecked, open+unmapped checked", () => {
    expect(defaultChecked(row({ lifecycle: "closed" }))).toBe(false);
    expect(defaultChecked(row({ mappedTicketId: "t" as any }))).toBe(false);
    expect(defaultChecked(row({}))).toBe(true);
  });

  it("selectionKey + groupSelectedBySource bucket externalIds per source", () => {
    const keys = new Set([
      selectionKey(row({})),
      selectionKey(row({ sourceId: "s2", externalId: "9" })),
    ]);
    const groups = groupSelectedBySource(keys);
    expect(groups).toEqual({ s1: ["1"], s2: ["9"] });
  });

  it("isUrl detects http(s) urls", () => {
    expect(isUrl("https://x/y")).toBe(true);
    expect(isUrl("fix bug")).toBe(false);
  });
});
