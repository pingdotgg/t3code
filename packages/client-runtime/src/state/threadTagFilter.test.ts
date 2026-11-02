import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadKey } from "./entities.ts";
import { hiddenThreadKeys, NO_HIDDEN_THREADS } from "./threadTagFilter.ts";

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

  it("applies each environment's own tags", () => {
    expect(hiddenIds(null, ["client", "private"])).toEqual([key(linked, "linked-client")]);
  });
});
