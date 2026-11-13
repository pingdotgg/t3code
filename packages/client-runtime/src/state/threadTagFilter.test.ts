import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import {
  collectThreadTags,
  filterThreadsByTag,
  hiddenThreadKeys,
  NO_HIDDEN_THREADS,
  suggestThreadTags,
  validateThreadTag,
  visibleLinkedThreads,
} from "./threadTagFilter.ts";

const local = EnvironmentId.make("local");
const linked = EnvironmentId.make("linked");

const thread = (
  id: string,
  tags: Array<string>,
  parent?: { readonly id: string; readonly relationship: "fork" | "subagent" },
  delegatedFrom?: { readonly environmentId: EnvironmentId; readonly id: string },
) => ({
  id: ThreadId.make(id),
  tags,
  lineage: {
    parentThreadId: parent === undefined ? null : ThreadId.make(parent.id),
    relationshipToParent: parent?.relationship ?? null,
    rootThreadId: ThreadId.make(parent?.id ?? id),
  },
  ...(delegatedFrom === undefined
    ? {}
    : {
        delegatedFrom: {
          environmentId: delegatedFrom.environmentId,
          threadId: ThreadId.make(delegatedFrom.id),
          title: "parent",
        },
      }),
});

const localThreads = [
  thread("private", ["private"]),
  thread("private-subagent", [], { id: "private", relationship: "subagent" }),
  thread("private-fork", [], { id: "private", relationship: "fork" }),
  thread("plain", []),
  thread("plain-private-side-chat", ["private"], { id: "plain", relationship: "subagent" }),
];
const linkedThreads = [
  thread("delegated-from-private", [], undefined, { environmentId: local, id: "private" }),
  thread("linked-client", ["client"]),
];
const hiddenIds = (localTags: Array<string> | null, linkedTags: Array<string> | null) =>
  [
    ...hiddenThreadKeys([
      { environmentId: local, threads: localThreads, hiddenTags: localTags },
      { environmentId: linked, threads: linkedThreads, hiddenTags: linkedTags },
    ]),
  ].toSorted();
const key = (environmentId: EnvironmentId, id: string) =>
  threadKey({ environmentId, threadId: ThreadId.make(id) });

describe("hiddenThreadKeys", () => {
  it("hides nothing while every filter is off", () => {
    expect(hiddenIds(null, null)).toEqual([]);
    expect(
      hiddenThreadKeys([{ environmentId: local, threads: localThreads, hiddenTags: null }]),
    ).toBe(NO_HIDDEN_THREADS);
  });

  it("hides a tagged thread with its subagents and linked tasks, but not its forks", () => {
    expect(hiddenIds(["private"], null)).toEqual(
      [
        key(local, "private"),
        key(local, "private-subagent"),
        key(linked, "delegated-from-private"),
      ].toSorted(),
    );
  });

  it("judges an archive page against live hidden parents", () => {
    const archived = hiddenThreadKeys(
      [{ environmentId: linked, threads: [linkedThreads[0]!], hiddenTags: null }],
      new Set([key(local, "private")]),
    );
    expect([...archived]).toEqual([key(linked, "delegated-from-private")]);
  });

  it("hides a child whose parent is not loaded while any environment hides tags", () => {
    const orphan = thread("orphan-task", [], undefined, { environmentId: local, id: "archived" });
    const keys = (localTags: Array<string> | null, linkedTags: Array<string> | null) => [
      ...hiddenThreadKeys([
        { environmentId: local, threads: [], hiddenTags: localTags },
        { environmentId: linked, threads: [orphan], hiddenTags: linkedTags },
      ]),
    ];
    expect(keys(["private"], null)).toEqual([key(linked, "orphan-task")]);
    expect(keys(null, ["client"])).toEqual([key(linked, "orphan-task")]);
    expect(keys(null, null)).toEqual([]);
  });

  it("applies each environment's own tags", () => {
    expect(hiddenIds(null, ["client", "private"])).toEqual([key(linked, "linked-client")]);
    expect(hiddenIds(null, ["Client"])).toEqual([key(linked, "linked-client")]);
  });

  it("judges loaded PR rows by visibility and leaves out unloaded rows while hiding", () => {
    const hidden = hiddenThreadKeys([
      { environmentId: local, threads: localThreads, hiddenTags: ["private"] },
    ]);
    const rows = [
      { id: ThreadId.make("private-subagent") },
      { id: ThreadId.make("plain-private-side-chat") },
      { id: ThreadId.make("off-shell") },
    ];
    const loaded = localThreads.map((entry) => ({ environmentId: local, threadId: entry.id }));
    const visible = (hiding: boolean) =>
      visibleLinkedThreads(rows, local, loaded, hidden, hiding).map((row) => row.id);
    expect(visible(true)).toEqual(["plain-private-side-chat"]);
    // Another machine hides tags while nothing here is hidden: unloaded rows still stay out.
    expect(
      visibleLinkedThreads(rows, local, loaded, NO_HIDDEN_THREADS, true).map((row) => row.id),
    ).toEqual(["private-subagent", "plain-private-side-chat"]);
    expect(visibleLinkedThreads(rows, local, loaded, NO_HIDDEN_THREADS, false)).toBe(rows);
  });

  it("lets a live hidden parent win over the same parent being loaded elsewhere", () => {
    const parentKey = key(local, "private");
    const archived = hiddenThreadKeys(
      [{ environmentId: linked, threads: [linkedThreads[0]!], hiddenTags: null }],
      new Set([parentKey]),
      new Set([parentKey]),
    );
    expect([...archived]).toEqual([key(linked, "delegated-from-private")]);
  });
});

describe("filterThreadsByTag", () => {
  const shells = [
    { ...thread("parent", []), environmentId: local },
    {
      ...thread("tagged-subagent", ["review"], { id: "parent", relationship: "subagent" }),
      environmentId: local,
    },
    { ...thread("tagged", ["review"]), environmentId: local },
    {
      ...thread("tagged-child", [], { id: "tagged", relationship: "subagent" }),
      environmentId: local,
    },
    { ...thread("other", ["later"]), environmentId: local },
    { ...thread("loop-a", [], { id: "loop-b", relationship: "subagent" }), environmentId: local },
    { ...thread("loop-b", [], { id: "loop-a", relationship: "subagent" }), environmentId: local },
  ];
  const ids = (tags: ReadonlyArray<string>) =>
    filterThreadsByTag(shells, tags).map((shell) => String(shell.id));

  it("keeps tagged threads, the parents they nest under, and their children", () => {
    expect(ids(["review"])).toEqual(["parent", "tagged-subagent", "tagged", "tagged-child"]);
  });

  it("lists everything without a filter, nothing for an unused tag, and any match for several", () => {
    expect(ids([])).toHaveLength(shells.length);
    expect(ids(["missing"])).toEqual([]);
    expect(ids(["later", "missing"])).toEqual(["other"]);
    expect(ids(["LATER"])).toEqual(["other"]);
  });
});

describe("validateThreadTag", () => {
  it.each([
    ["  ", [], { kind: "empty" }],
    [" review ", [], { kind: "ok", tag: "review" }],
    ["review", ["review"], { kind: "error", message: "Already tagged." }],
    ["Review", ["review"], { kind: "error", message: "Already tagged." }],
    ["x".repeat(65), [], { kind: "error", message: "Tags are 64 characters at most." }],
    ["a\u0007b", [], { kind: "error", message: "Tags are one line of text." }],
  ] as const)("%j", (input, own, expected) => {
    expect(validateThreadTag(input, own)).toEqual(expected);
  });
});

it("suggests known tags the thread lacks, matching the query case-insensitively", () => {
  expect(suggestThreadTags(["auth", "Review", "later"], ["later"], "rev")).toEqual(["Review"]);
  expect(suggestThreadTags(["auth", "Review", "later"], ["LATER"])).toEqual(["auth", "Review"]);
});

it("collects each tag once, ignoring case, in the first spelling seen", () => {
  expect(collectThreadTags([{ tags: ["bug", "Later"] }, { tags: ["Bug", "auth"] }, {}])).toEqual([
    "auth",
    "bug",
    "Later",
  ]);
});
