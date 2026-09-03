import { describe, expect, it } from "vite-plus/test";

import { groupThreadsWithAddonContributions, type SidebarThreadAddonContribution } from "./sidebar";

const contribution = (
  threadId: string,
  parentThreadId: string | null,
): SidebarThreadAddonContribution => ({
  addonId: "test",
  threadId,
  parentThreadId,
  kind: parentThreadId === null ? "parent" : "child",
  compact: null,
  card: null,
});

describe("groupThreadsWithAddonContributions", () => {
  it("places explicitly parented rows under their parent", () => {
    const parent = { id: "parent" };
    const child = { id: "child" };
    const plain = { id: "plain" };
    const groups = groupThreadsWithAddonContributions(
      [parent, child, plain],
      [contribution("parent", null), contribution("child", "parent")],
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ thread: parent, children: [{ thread: child }] });
    expect(groups[1]).toMatchObject({ thread: plain, contribution: null, children: [] });
  });

  it("leaves a child top-level when its parent is absent", () => {
    const child = { id: "child" };
    expect(
      groupThreadsWithAddonContributions([child], [contribution("child", "missing")]),
    ).toMatchObject([{ thread: child, contribution: { threadId: "child" }, children: [] }]);
  });
});
