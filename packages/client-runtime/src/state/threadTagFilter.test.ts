import { DEFAULT_THREAD_TAG_FILTER, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterThreadsByTagFilter } from "./threadTagFilter.ts";

const thread = (
  id: string,
  tags: Array<string>,
  parent?: { readonly id: string; readonly relationship: "fork" | "subagent" },
) => ({
  id: ThreadId.make(id),
  tags,
  lineage: {
    parentThreadId: parent === undefined ? null : ThreadId.make(parent.id),
    relationshipToParent: parent?.relationship ?? null,
    rootThreadId: ThreadId.make(parent?.id ?? id),
  },
});

const threads = [
  thread("private", ["private"]),
  thread("private-subagent", [], { id: "private", relationship: "subagent" }),
  thread("private-fork", [], { id: "private", relationship: "fork" }),
  thread("demo", ["demo"]),
  thread("demo-subagent", [], { id: "demo", relationship: "subagent" }),
  thread("plain", []),
];
const visibleIds = (filter: Partial<typeof DEFAULT_THREAD_TAG_FILTER>) =>
  filterThreadsByTagFilter(threads, { ...DEFAULT_THREAD_TAG_FILTER, ...filter }).map(
    (entry) => entry.id,
  );

describe("filterThreadsByTagFilter", () => {
  it("keeps every thread while the filter is off", () => {
    expect(
      filterThreadsByTagFilter(threads, { ...DEFAULT_THREAD_TAG_FILTER, hide: ["private"] }),
    ).toBe(threads);
  });

  it("hides tagged threads and the subagents under them, but not their forks", () => {
    expect(visibleIds({ enabled: true, hide: ["private"] })).toEqual([
      "private-fork",
      "demo",
      "demo-subagent",
      "plain",
    ]);
  });

  it("keeps only threads with an `only` tag, plus their subagents", () => {
    expect(visibleIds({ enabled: true, only: ["demo"] })).toEqual(["demo", "demo-subagent"]);
  });

  it("lets `hide` win over `only`", () => {
    expect(visibleIds({ enabled: true, hide: ["demo"], only: ["demo"] })).toEqual([]);
  });
});
