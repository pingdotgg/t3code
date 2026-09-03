import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  flattenSidebarAddonGroups,
  groupThreadsWithAddonContributions,
  type SidebarThreadAddonContribution,
} from "./sidebar";

const ENV_A = EnvironmentId.make("environment-a");
const ENV_B = EnvironmentId.make("environment-b");

function thread(environmentId: EnvironmentId, id: string) {
  return { environmentId, id: ThreadId.make(id) };
}

function contribution(input: {
  addonId: string;
  contributionId?: string;
  environmentId?: EnvironmentId;
  threadId: string;
  parentThreadId?: string | null;
}): SidebarThreadAddonContribution {
  const environmentId = input.environmentId ?? ENV_A;
  const parentThreadId = input.parentThreadId ?? null;
  return {
    addonId: input.addonId,
    contributionId: input.contributionId ?? "status",
    threadRef: scopeThreadRef(environmentId, ThreadId.make(input.threadId)),
    parentThreadRef:
      parentThreadId === null ? null : scopeThreadRef(environmentId, ThreadId.make(parentThreadId)),
    kind: parentThreadId === null ? "parent" : "child",
    compact: null,
    card: null,
  };
}

describe("groupThreadsWithAddonContributions", () => {
  it("places explicitly parented rows under their parent", () => {
    const parent = thread(ENV_A, "parent");
    const child = thread(ENV_A, "child");
    const plain = thread(ENV_A, "plain");
    const groups = groupThreadsWithAddonContributions(
      [parent, child, plain],
      [
        contribution({ addonId: "test", threadId: "parent" }),
        contribution({ addonId: "test", threadId: "child", parentThreadId: "parent" }),
      ],
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      thread: parent,
      presentation: { kind: "parent" },
      children: [{ thread: child, presentation: { kind: "child" } }],
    });
    expect(groups[1]).toMatchObject({ thread: plain, presentation: null, children: [] });
  });

  it("renders a missing-parent child as a standalone top-level row", () => {
    const child = thread(ENV_A, "child");
    expect(
      groupThreadsWithAddonContributions(
        [child],
        [contribution({ addonId: "test", threadId: "child", parentThreadId: "missing" })],
      ),
    ).toMatchObject([{ thread: child, presentation: { kind: "standalone" }, children: [] }]);
  });

  it("scopes identical thread ids to their environments", () => {
    const parentA = thread(ENV_A, "parent");
    const childA = thread(ENV_A, "child");
    const parentB = thread(ENV_B, "parent");
    const childB = thread(ENV_B, "child");
    const groups = groupThreadsWithAddonContributions(
      [parentA, childA, parentB, childB],
      [
        contribution({
          addonId: "test",
          environmentId: ENV_B,
          threadId: "child",
          parentThreadId: "parent",
        }),
      ],
    );

    expect(groups.map((group) => group.thread)).toEqual([parentA, childA, parentB]);
    expect(groups[0]?.children).toEqual([]);
    expect(groups[2]?.children.map((child) => child.thread)).toEqual([childB]);
  });

  it("composes addon UI but deduplicates an agreed child relationship", () => {
    const parent = thread(ENV_A, "parent");
    const child = thread(ENV_A, "child");
    const groups = groupThreadsWithAddonContributions(
      [parent, child],
      [
        contribution({
          addonId: "fleet",
          contributionId: "role",
          threadId: "child",
          parentThreadId: "parent",
        }),
        contribution({
          addonId: "labels",
          contributionId: "labels",
          threadId: "child",
          parentThreadId: "parent",
        }),
      ],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.children).toHaveLength(1);
    expect(groups[0]?.children[0]?.presentation.contributions).toHaveLength(2);
    expect(flattenSidebarAddonGroups(groups)).toEqual([parent, child]);
  });

  it("leaves conflicting and nested relationships top-level instead of hiding rows", () => {
    const parentA = thread(ENV_A, "parent-a");
    const parentB = thread(ENV_A, "parent-b");
    const child = thread(ENV_A, "child");
    const grandchild = thread(ENV_A, "grandchild");
    const groups = groupThreadsWithAddonContributions(
      [parentA, parentB, child, grandchild],
      [
        contribution({ addonId: "one", threadId: "child", parentThreadId: "parent-a" }),
        contribution({ addonId: "two", threadId: "child", parentThreadId: "parent-b" }),
        contribution({ addonId: "one", threadId: "grandchild", parentThreadId: "child" }),
      ],
    );

    expect(
      groups.flatMap((group) => [group.thread, ...group.children.map((member) => member.thread)]),
    ).toEqual([parentA, parentB, child, grandchild]);
    expect(groups.every((group) => group.presentation?.kind !== "child")).toBe(true);
  });

  it("does not hide a grandchild when its parent is already attached", () => {
    const parent = thread(ENV_A, "parent");
    const child = thread(ENV_A, "child");
    const grandchild = thread(ENV_A, "grandchild");
    const groups = groupThreadsWithAddonContributions(
      [parent, child, grandchild],
      [
        contribution({ addonId: "fleet", threadId: "child", parentThreadId: "parent" }),
        contribution({ addonId: "fleet", threadId: "grandchild", parentThreadId: "child" }),
      ],
    );

    expect(groups.map((group) => group.thread)).toEqual([parent, grandchild]);
    expect(groups[0]?.children.map((member) => member.thread)).toEqual([child]);
    expect(groups[1]?.presentation?.kind).toBe("standalone");
  });
});
