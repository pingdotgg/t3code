import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildMobileThreadTree,
  nestedThreadCompletionMarker,
  nestedThreadParentError,
  relatedThreadRows,
  type MobileThreadTreeRow,
} from "./mobile-thread-hierarchy";
import { applyShellStreamEvent } from "@t3tools/client-runtime";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  resolveThreadListV2Enabled,
  resolveThreadListV2RootState,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2Status,
  resolveThreadListV2SwipeActions,
  sortThreadsForListV2,
  threadListV2ItemsAreEqual,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { resolveDaysDraftCommit } from "../settings/SettingsRouteScreen.logic";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Partial<EnvironmentThreadShell> & Pick<EnvironmentThreadShell, "id" | "title">,
): EnvironmentThreadShell {
  return {
    environmentId,
    projectId: ProjectId.make("project-1"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasPendingQueuedTurn: false,
    ...input,
  };
}

const NOW = "2026-06-02T00:00:00.000Z";
const linkedPullRequest = {
  projectId: ProjectId.make("project-1"),
  repository: "pingdotgg/t3code",
  number: 42,
  url: "https://github.com/pingdotgg/t3code/pull/42",
};

describe("mobile nested threads", () => {
  const parent = makeThread({ id: ThreadId.make("parent"), title: "Parent" });
  const child = makeThread({
    id: ThreadId.make("child"),
    title: "Child",
    parentThreadId: parent.id,
  });
  const leaf = makeThread({ id: ThreadId.make("leaf"), title: "Leaf", parentThreadId: child.id });
  const layout = (
    threads: readonly EnvironmentThreadShell[],
    extra: Partial<Parameters<typeof buildThreadListV2Items>[0]> = {},
  ) =>
    buildThreadListV2Items({ threads, environmentId: null, searchQuery: "", now: NOW, ...extra });

  it("does not show root completion Done for child rows", () => {
    expect(
      resolveThreadListV2Status({
        ...child,
        latestTurn: {
          turnId: TurnId.make("child-turn"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
    ).toBe("ready");
  });

  it("projects root completion receipts into row item status", () => {
    const completed = {
      ...parent,
      latestTurn: {
        turnId: TurnId.make("completed-root"),
        state: "completed" as const,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    };

    expect(layout([completed]).items[0]?.status).toBe("completed");
    expect(
      layout([completed], {
        threadCompletionReadAt: { [`${environmentId}:${completed.id}`]: NOW },
      }).items[0]?.status,
    ).toBe("ready");
  });

  it("preserves root and child order without depending on ES2023 copy-array methods", () => {
    const reverse = vi.spyOn(Array.prototype, "toReversed").mockImplementation(() => {
      throw new TypeError("toReversed is unavailable");
    });
    try {
      const other = makeThread({ id: ThreadId.make("other"), title: "Other", updatedAt: NOW });
      expect(layout([leaf, child, parent, other]).items.map((item) => item.thread.id)).toEqual([
        "other",
        "parent",
        "child",
        "leaf",
      ]);
      expect(
        relatedThreadRows(
          buildMobileThreadTree([leaf, child, parent, other]),
          `${environmentId}:parent`,
        ).map((row) => row.thread.id),
      ).toEqual(["parent", "child", "leaf"]);
    } finally {
      reverse.mockRestore();
    }
  });

  it("keeps descendant attention separate from the parent's higher-priority state during search", () => {
    const result = layout(
      [
        { ...parent, hasPendingApprovals: true },
        {
          ...child,
          latestTurn: {
            turnId: TurnId.make("failed-turn"),
            state: "error",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        },
      ],
      { searchQuery: "Parent" },
    );
    expect(result.items[0]?.hierarchy).toMatchObject({
      displayStatus: "approval",
      relatedStatus: "failed",
      childCount: 1,
    });
    expect(
      layout([{ ...parent, hasPendingApprovals: true }, child]).items[0]?.hierarchy,
    ).toMatchObject({ displayStatus: "approval", relatedStatus: "ready" });
  });

  it("collapses inline subchats behind the parent while keeping the group reachable", () => {
    const collapsed = new Set([`${environmentId}:parent`]);
    const result = layout([leaf, parent, child], { collapsedThreadKeys: collapsed });
    expect(result.items.map((item) => item.thread.id)).toEqual(["parent"]);
    expect(result.items[0]?.hierarchy).toMatchObject({
      isExpanded: false,
      childCount: 2,
      relatedChildCount: 2,
    });
  });

  it("lets an explicit collapse win over active children", () => {
    const workingChild = { ...child, hasPendingQueuedTurn: true };
    const collapsed = new Set([`${environmentId}:parent`]);
    const result = layout([parent, workingChild], { collapsedThreadKeys: collapsed });
    expect(result.items.map((item) => item.thread.id)).toEqual(["parent"]);
    expect(result.items[0]?.hierarchy).toMatchObject({ isExpanded: false, childCount: 1 });
  });

  it("forces collapsed ancestors open for the selected conversation", () => {
    const collapsed = new Set([`${environmentId}:parent`]);
    const items = layout([leaf, parent, child], {
      collapsedThreadKeys: collapsed,
      selectedThreadKey: `${environmentId}:leaf`,
    }).items;
    expect(items.map((item) => [item.thread.id, item.hierarchy?.depth])).toEqual([
      ["parent", 0],
      ["child", 1],
      ["leaf", 2],
    ]);
    expect(items[0]?.hierarchy?.isExpanded).toBe(true);
  });

  it("lets a selected parent stay collapsed so its chevron responds", () => {
    const collapsed = new Set([`${environmentId}:parent`]);
    const items = layout([leaf, parent, child], {
      collapsedThreadKeys: collapsed,
      selectedThreadKey: `${environmentId}:parent`,
    }).items;
    expect(items.map((item) => item.thread.id)).toEqual(["parent"]);
    expect(items[0]?.hierarchy).toMatchObject({ isExpanded: false, childCount: 2 });
  });

  it("suspends collapse while searching so matches never hide", () => {
    const collapsed = new Set([`${environmentId}:parent`]);
    expect(
      layout([leaf, parent, child], {
        collapsedThreadKeys: collapsed,
        searchQuery: "Leaf",
      }).items.map((item) => item.thread.id),
    ).toEqual(["parent", "leaf"]);
  });

  it("shows nested threads inline while retaining the selected iPad conversation", () => {
    expect(layout([leaf, parent, child]).items.map((item) => item.thread.id)).toEqual([
      "parent",
      "child",
      "leaf",
    ]);
    const items = layout([leaf, parent, child], {
      selectedThreadKey: `${environmentId}:leaf`,
    }).items;
    expect(items.map((item) => [item.thread.id, item.hierarchy?.depth])).toEqual([
      ["parent", 0],
      ["child", 1],
      ["leaf", 2],
    ]);
  });

  it("promotes a shelved parent for blocked or queued descendant work and rolls up archive guards", () => {
    const result = layout([
      { ...parent, settledOverride: "settled", snoozedUntil: "2026-06-03T00:00:00Z" },
      { ...child, hasPendingQueuedTurn: true },
      { ...leaf, hasPendingApprovals: true },
    ]);
    expect(result.settledCount).toBe(0);
    expect(result.snoozedCount).toBe(0);
    expect(result.items[0]?.hierarchy).toMatchObject({
      displayStatus: "approval",
      archiveBlocked: true,
    });
    expect(result.items.map((item) => item.thread.id)).toEqual(["parent", "child", "leaf"]);
    expect(result.items[0]?.hierarchy?.childCount).toBe(2);
  });

  it.each(["snoozed", "settled"] as const)(
    "promotes a %s parent for an unread completed descendant without changing its status",
    (shelf) => {
      const completedChild = {
        ...child,
        latestTurn: {
          turnId: TurnId.make("completed-child-turn"),
          state: "completed" as const,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      };
      const shelvedParent =
        shelf === "snoozed"
          ? { ...parent, snoozedUntil: "2026-06-03T00:00:00.000Z" }
          : { ...parent, settledOverride: "settled" as const, settledAt: NOW };
      const result = layout([shelvedParent, completedChild], {
        snoozedShelfExpanded: false,
        settledShelfExpanded: false,
      });
      expect(result.snoozedCount).toBe(0);
      expect(result.settledCount).toBe(0);
      expect(result.items.map((item) => item.thread.id)).toEqual([parent.id, child.id]);
      expect(result.items[0]?.hierarchy).toMatchObject({
        displayStatus: "ready",
        relatedStatus: "ready",
        hasUnreadDescendant: true,
      });
    },
  );

  it("keeps terminal children until they are read, while active children ignore read markers", () => {
    const completedChild = {
      ...child,
      latestTurn: {
        turnId: TurnId.make("child-turn"),
        state: "completed" as const,
        requestedAt: "2026-06-01T23:00:00.000Z",
        startedAt: "2026-06-01T23:01:00.000Z",
        completedAt: NOW,
        assistantMessageId: null,
      },
    };
    const readMarkers = { [`${environmentId}:${child.id}`]: NOW };
    expect(layout([parent, completedChild]).items.map((item) => item.thread.id)).toEqual([
      parent.id,
      child.id,
    ]);
    expect(
      layout([parent, completedChild], { threadChildReadAt: readMarkers }).items.map(
        (item) => item.thread.id,
      ),
    ).toEqual([parent.id]);
    expect(
      layout([parent, completedChild], { threadChildReadAt: readMarkers }).items[0]?.hierarchy,
    ).toMatchObject({ childCount: 0, relatedChildCount: 1 });

    const workingChild = {
      ...completedChild,
      latestTurn: { ...completedChild.latestTurn, state: "running" as const },
    };
    expect(
      layout([parent, workingChild], { threadChildReadAt: readMarkers }).items.map(
        (item) => item.thread.id,
      ),
    ).toEqual([parent.id, child.id]);
  });

  it("shows read terminal children when searching", () => {
    const completedChild = {
      ...child,
      latestTurn: {
        turnId: TurnId.make("child-turn"),
        state: "error" as const,
        requestedAt: "2026-06-01T23:00:00.000Z",
        startedAt: "2026-06-01T23:01:00.000Z",
        completedAt: NOW,
        assistantMessageId: null,
      },
    };
    expect(
      layout([parent, completedChild], {
        searchQuery: "Child",
        threadChildReadAt: { [`${environmentId}:${child.id}`]: NOW },
      }).items.map((item) => item.thread.id),
    ).toEqual([parent.id, child.id]);
  });

  it("counts every branch after completed descendants are read", () => {
    const descendants = [
      child,
      leaf,
      { ...leaf, id: ThreadId.make("second-leaf") },
      { ...child, id: ThreadId.make("sibling") },
    ].map((thread) => ({
      ...thread,
      latestTurn: {
        turnId: TurnId.make(`${thread.id}-turn`),
        state: "completed" as const,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    }));
    const threadChildReadAt = Object.fromEntries(
      descendants.map((thread) => [`${environmentId}:${thread.id}`, NOW]),
    );
    const result = layout([parent, ...descendants], { threadChildReadAt });
    expect(result.items.map((item) => item.thread.id)).toEqual([parent.id]);
    expect(result.items[0]?.hierarchy).toMatchObject({
      childCount: 0,
      relatedChildCount: 4,
    });
    const group = relatedThreadRows(
      buildMobileThreadTree([parent, ...descendants]),
      `${environmentId}:${parent.id}`,
    );
    expect(group[0]?.relatedChildCount).toBe(4);
    expect(group.find((row) => row.thread.id === child.id)?.relatedChildCount).toBe(2);
  });

  it("uses normalized roots for completed children whose parent is missing", () => {
    const completedChild = {
      ...child,
      latestTurn: {
        turnId: TurnId.make("orphan-turn"),
        state: "completed" as const,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    };
    const threadChildReadAt = { [`${environmentId}:${child.id}`]: NOW };
    expect(layout([completedChild], { threadChildReadAt }).items[0]?.hierarchy).toMatchObject({
      threadKey: `${environmentId}:${child.id}`,
      depth: 0,
    });
    expect(
      layout([{ ...parent, archivedAt: NOW }, completedChild], { threadChildReadAt }).items,
    ).toEqual([]);
  });

  it("normalizes cyclic parentage before revealing ancestors", () => {
    const tree = buildMobileThreadTree([{ ...parent, parentThreadId: leaf.id }, child, leaf]);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    const rows = relatedThreadRows(tree, root.threadKey);
    expect(new Set(rows.map((row) => row.threadKey)).size).toBe(3);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
    expect(root.relatedChildCount).toBe(2);
    expect(
      buildMobileThreadTree([{ ...parent, parentThreadId: parent.id }])[0]?.descendantCount,
    ).toBe(0);
  });

  it("hides read terminal failures from the default list", () => {
    const failedChild = {
      ...child,
      latestTurn: {
        turnId: TurnId.make("failed-child-turn"),
        state: "error" as const,
        requestedAt: "2026-06-01T23:00:00.000Z",
        startedAt: "2026-06-01T23:01:00.000Z",
        completedAt: NOW,
        assistantMessageId: null,
      },
    };
    expect(
      layout([parent, failedChild], {
        threadChildReadAt: { [`${environmentId}:${child.id}`]: NOW },
      }).items.map((item) => item.thread.id),
    ).toEqual([parent.id]);
  });

  it("sorts siblings and roots by subtree activity without detaching children", () => {
    const newer = makeThread({
      id: ThreadId.make("newer"),
      title: "Newer",
      parentThreadId: parent.id,
      updatedAt: NOW,
    });
    const other = makeThread({
      id: ThreadId.make("other"),
      title: "Other",
      updatedAt: "2026-06-01T12:00:00Z",
    });
    expect(layout([parent, child, newer, other]).items.map((item) => item.thread.id)).toEqual([
      "parent",
      "newer",
      "child",
      "other",
    ]);
    expect(
      relatedThreadRows(
        buildMobileThreadTree([parent, child, newer, other]),
        `${environmentId}:parent`,
      ).map((row) => row.thread.id),
    ).toEqual(["parent", "newer", "child"]);
  });

  it("keeps ancestry during content search and roots the child only after parent deletion", () => {
    expect(
      layout([parent, child, leaf], {
        searchQuery: "needle",
        matchedThreadKeys: new Set([threadSearchMatchKey({ environmentId, threadId: leaf.id })]),
      }).items.map((item) => item.thread.id),
    ).toEqual(["parent", "leaf"]);
    expect(layout([child]).items[0]?.hierarchy?.depth).toBe(0);
    expect(layout([{ ...parent, archivedAt: NOW }, child, leaf]).items).toEqual([]);
  });

  it.each(["title", "content"])("reveals %s matches on collapsed shelves", (kind) => {
    for (const shelf of ["snoozed", "settled"]) {
      const threads = [
        {
          ...parent,
          ...(shelf === "snoozed"
            ? { snoozedUntil: "2026-06-03T00:00:00Z" }
            : { settledOverride: "settled" as const }),
        },
        child,
        leaf,
      ];
      const options = {
        snoozedShelfExpanded: false,
        settledShelfExpanded: false,
        ...(kind === "content"
          ? {
              matchedThreadKeys: new Set([
                threadSearchMatchKey({ environmentId, threadId: leaf.id }),
              ]),
            }
          : {}),
      };
      expect(
        layout(threads, {
          ...options,
          searchQuery: kind === "title" ? "Leaf" : "needle",
        }).items.map((item) => item.thread.id),
      ).toEqual(["parent", "leaf"]);
      expect(layout(threads, { ...options, searchQuery: "" }).items).toEqual([]);
    }
  });

  it("prunes unmatched siblings and descendants without losing ancestor safety rollups", () => {
    const sibling = makeThread({
      id: ThreadId.make("sibling"),
      title: "Unrelated",
      parentThreadId: parent.id,
      hasPendingQueuedTurn: true,
    });
    const threads = [parent, child, leaf, sibling];
    const result = layout(threads, {
      searchQuery: "Leaf",
    });
    expect(result.items.map((item) => item.thread.id)).toEqual(["parent", "leaf"]);
    expect(result.items[0]?.hierarchy).toMatchObject({
      archiveBlocked: true,
      displayStatus: "working",
    });
    expect(layout(threads, { searchQuery: "Parent" }).items.map((item) => item.thread.id)).toEqual([
      "parent",
    ]);
    expect(layout(threads).items.map((item) => item.thread.id)).toEqual([
      "parent",
      "child",
      "leaf",
      "sibling",
    ]);
  });

  it("uses an errored session timestamp when a failed child has no completed turn", () => {
    const failedChild = {
      ...child,
      session: {
        threadId: child.id,
        status: "error" as const,
        providerName: null,
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: "Provider failed",
        updatedAt: NOW,
      },
    };
    expect(nestedThreadCompletionMarker(failedChild)).toBe(NOW);
    expect(
      layout([parent, failedChild], {
        threadChildReadAt: { [`${environmentId}:${child.id}`]: NOW },
      }).items.map((item) => item.thread.id),
    ).toEqual([parent.id]);
  });

  it("keeps a read terminal child visible while it is selected", () => {
    const completedChild = {
      ...child,
      latestTurn: {
        turnId: TurnId.make("completed-child"),
        state: "completed" as const,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    };
    const result = layout([parent, completedChild], {
      selectedThreadKey: `${environmentId}:${child.id}`,
      threadChildReadAt: { [`${environmentId}:${child.id}`]: NOW },
    });
    expect(result.items.map((item) => item.thread.id)).toEqual([parent.id, child.id]);
  });

  it("shows failed provider agents and promotes their shelved ancestors until dismissed", () => {
    const failedParent = {
      ...parent,
      settledOverride: "settled" as const,
      backgroundAgentRuns: [
        { taskId: "failed", name: "Failed check", status: "failed" as const, startedAt: NOW },
      ],
    };
    const result = layout([failedParent]);
    expect(result.items.map((item) => item.hierarchy?.displayStatus)).toEqual(["failed", "failed"]);
    expect(result.settledCount).toBe(0);
    expect(result.items.every((item) => item.hierarchy?.archiveBlocked === false)).toBe(true);
    expect(
      layout([failedParent], {
        dismissedAgentRunKeys: [`${environmentId}:agent-run:parent:failed`],
      }).settledCount,
    ).toBe(1);
  });

  it("pages root groups rather than children and keeps selected descendants on closed shelves", () => {
    const other = makeThread({
      id: ThreadId.make("other"),
      title: "Other",
      settledOverride: "settled",
      settledAt: NOW,
    });
    const result = layout([{ ...parent, settledOverride: "settled" }, child, leaf, other], {
      settledLimit: 0,
      settledShelfExpanded: false,
      selectedThreadKey: `${environmentId}:leaf`,
    });
    expect(result.settledCount).toBe(2);
    expect(result.items.map((item) => item.thread.id)).toEqual(["parent", "child", "leaf"]);
  });

  it("shows provider background runs as local children, never as independent server threads", () => {
    const result = layout([
      {
        ...parent,
        backgroundAgentRuns: [
          {
            taskId: "task-1",
            name: "Checking native state",
            status: "running",
            startedAt: NOW,
          },
        ],
      },
    ]);
    expect(result.items.map((item) => item.thread.id)).toEqual([
      "parent",
      "agent-run:parent:task-1",
    ]);
    expect(result.items[0]?.hierarchy).toMatchObject({
      displayStatus: "working",
      archiveBlocked: true,
    });
    const group = relatedThreadRows(
      buildMobileThreadTree(result.items.map((item) => item.thread)),
      `${environmentId}:parent`,
    );
    expect(group.map((row) => row.thread.id)).toEqual(["parent", "agent-run:parent:task-1"]);
    expect(group[1]?.thread.virtualAgentRun?.parentThreadId).toBe(parent.id);
    const finished = {
      ...parent,
      backgroundAgentRuns: [
        {
          taskId: "task-1",
          name: "Checking native state",
          status: "completed" as const,
          startedAt: NOW,
        },
      ],
    };
    expect(
      layout([finished], { dismissedAgentRunKeys: [`${environmentId}:agent-run:parent:task-1`] })
        .items,
    ).toHaveLength(1);
  });

  it("keeps completed provider runs in a matching parent search", () => {
    const result = layout(
      [
        {
          ...parent,
          backgroundAgentRuns: [
            {
              taskId: "completed",
              name: "Completed check",
              status: "completed" as const,
              startedAt: NOW,
              completedAt: NOW,
            },
          ],
        },
      ],
      { searchQuery: "Parent" },
    );
    expect(result.items.map((item) => item.thread.id)).toEqual([
      parent.id,
      "agent-run:parent:completed",
    ]);
  });

  it("keeps parentage and child notification timestamps through live shell replacement and resnapshot", () => {
    const snapshot = {
      snapshotSequence: 0,
      projects: [],
      threads: [parent, child],
      updatedAt: NOW,
    };
    const next = applyShellStreamEvent(snapshot, {
      kind: "thread-upserted",
      sequence: 1,
      thread: { ...parent, latestChildNotificationAt: NOW },
    });
    expect(next.threads[0]?.latestChildNotificationAt).toBe(NOW);
    const resnapshot = JSON.parse(JSON.stringify(next));
    expect(
      layout(resnapshot.threads, { selectedThreadKey: `${environmentId}:child` }).items.map(
        (item) => item.thread.id,
      ),
    ).toEqual(["parent", "child"]);
    const decoupled = applyShellStreamEvent(next, {
      kind: "thread-upserted",
      sequence: 2,
      thread: { ...child, parentThreadId: null },
    });
    expect(
      buildMobileThreadTree(decoupled.threads.map((thread) => ({ ...thread, environmentId }))),
    ).toHaveLength(2);
  });

  it("rejects removed, archived and cross-project parents without substituting a root", () => {
    expect(nestedThreadParentError(parent.id, parent.projectId, [])).toContain("no longer active");
    expect(
      nestedThreadParentError(parent.id, parent.projectId, [{ ...parent, archivedAt: NOW }]),
    ).toContain("no longer active");
    expect(nestedThreadParentError(parent.id, ProjectId.make("different"), [parent])).toContain(
      "different project",
    );
    expect(nestedThreadParentError(parent.id, parent.projectId, [parent])).toBeNull();
  });

  it("opens a complete flat group without mixing environments or losing deeper descendants", () => {
    const otherEnvironment = EnvironmentId.make("another-environment");
    const tree = buildMobileThreadTree([
      parent,
      child,
      leaf,
      { ...parent, environmentId: otherEnvironment },
    ]);
    const rows = relatedThreadRows(tree, `${environmentId}:parent`);
    expect(rows.map((row) => row.thread.id)).toEqual(["parent", "child", "leaf"]);
    expect(rows.every((row) => row.thread.environmentId === environmentId)).toBe(true);
    expect(relatedThreadRows(tree, `${otherEnvironment}:parent`)).toHaveLength(1);
    expect(relatedThreadRows(tree, `${environmentId}:missing`)).toEqual([]);
    expect(
      relatedThreadRows(
        buildMobileThreadTree([{ ...parent, archivedAt: NOW }, child, leaf]),
        `${environmentId}:parent`,
      ),
    ).toEqual([]);
  });

  it("keeps deep unread activity on the group control even when search hides its branch", () => {
    const threads = [parent, { ...child, latestChildNotificationAt: NOW }, leaf];
    expect(layout(threads).items[0]?.hierarchy?.latestRelatedNotificationAt).toBe(NOW);
    expect(layout(threads, { searchQuery: "Parent" }).items[0]?.hierarchy).toMatchObject({
      childCount: 2,
      latestRelatedNotificationAt: NOW,
      displayStatus: "ready",
    });
    expect(
      relatedThreadRows(buildMobileThreadTree(threads), `${environmentId}:parent`)[0]
        ?.latestRelatedNotificationAt,
    ).toBe(NOW);
  });
});

describe("resolveThreadListV2SnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveThreadListV2SnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });

  it("recomputes presets that remain available instead of using old timestamps", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveThreadListV2SnoozeMenuSelection({
      event: "snooze:hour",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 60 * 60 * 1_000).toISOString(),
      );
    }
  });
});

describe("resolveThreadListV2Enabled", () => {
  it("defaults on when the device has never chosen", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: true }),
    ).toBe(true);
  });

  it("honors an explicit legacy opt-in", () => {
    expect(resolveThreadListV2Enabled({ legacyPreference: true, preferencesLoaded: true })).toBe(
      false,
    );
    expect(resolveThreadListV2Enabled({ legacyPreference: false, preferencesLoaded: true })).toBe(
      true,
    );
  });

  it("holds the default while preferences are still loading so the list does not remount", () => {
    expect(
      resolveThreadListV2Enabled({ legacyPreference: undefined, preferencesLoaded: false }),
    ).toBe(true);
  });
});

describe("resolveThreadListV2Status", () => {
  it("prioritizes approval over a running session", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      hasPendingApprovals: true,
      session: {
        threadId: ThreadId.make("t"),
        status: "running",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    });
    expect(resolveThreadListV2Status(thread)).toBe("approval");
  });

  it("resolves ready for quiescent threads", () => {
    expect(resolveThreadListV2Status(makeThread({ id: ThreadId.make("t"), title: "t" }))).toBe(
      "ready",
    );
  });
});

describe("resolveThreadListV2SwipeActions", () => {
  it("offers settle and snooze for an active snoozable thread", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: "snooze" });
  });

  it("offers un-settle and snooze for settled history", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
      }),
    ).toEqual({ primary: "unsettle", secondary: "snooze" });
  });

  it("omits snooze when the server or thread does not allow it", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "settle", secondary: null });
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: false,
      }),
    ).toEqual({ primary: "settle", secondary: null });
  });

  it("falls back to archive only for a pre-lifecycle server", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "card",
        settlementSupported: false,
        snoozeSupported: false,
        snoozable: true,
      }),
    ).toEqual({ primary: "archive", secondary: null });
  });

  it("offers wake and no snooze on a snoozed row", () => {
    expect(
      resolveThreadListV2SwipeActions({
        variant: "slim",
        settlementSupported: true,
        snoozeSupported: true,
        snoozable: true,
        snoozed: true,
      }),
    ).toEqual({ primary: "unsnooze", secondary: null });
  });
});

describe("resolveThreadListV2SnoozeGateExpiryMs", () => {
  it("reports when an unadopted turn's grace window lapses", () => {
    const thread = makeThread({
      id: ThreadId.make("t"),
      title: "t",
      latestUserMessageAt: "2026-06-02T00:00:30.000Z",
    });
    expect(resolveThreadListV2SnoozeGateExpiryMs(thread, { now: "2026-06-02T00:01:00.000Z" })).toBe(
      Date.parse("2026-06-02T00:02:30.000Z"),
    );
  });

  it("returns null once the thread is snoozable or when only data can unblock it", () => {
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({ id: ThreadId.make("ready"), title: "Ready" }),
        { now: NOW },
      ),
    ).toBe(null);
    expect(
      resolveThreadListV2SnoozeGateExpiryMs(
        makeThread({
          id: ThreadId.make("blocked"),
          title: "Blocked",
          hasPendingApprovals: true,
          latestUserMessageAt: NOW,
        }),
        { now: NOW },
      ),
    ).toBe(null);
  });
});

describe("sortThreadsForListV2", () => {
  it("orders by creation time, newest first, ignoring activity", () => {
    const sorted = sortThreadsForListV2([
      { id: "oldest", createdAt: "2026-06-01T08:00:00.000Z" },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("surfaces an un-settled thread at the top via its re-entry stamp", () => {
    const sorted = sortThreadsForListV2([
      {
        id: "old-unsettled",
        createdAt: "2026-06-01T08:00:00.000Z",
        unsettledAt: "2026-06-01T13:00:00.000Z",
      },
      { id: "newest", createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "middle", createdAt: "2026-06-01T10:00:00.000Z" },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["old-unsettled", "newest", "middle"]);
  });
});

describe("buildThreadListV2Items", () => {
  it("places a persisted settled thread in the settled shelf", () => {
    const thread = makeThread({
      id: ThreadId.make("linked-merged"),
      title: "Linked merged pull request",
      linkedPullRequest,
      settledOverride: "settled",
      settledAt: NOW,
    });
    const layout = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.settledCount).toBe(1);
    expect(layout.items[0]?.variant).toBe("slim");
  });

  it("hides snoozed threads and counts them — visibility parity with web", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("woken"),
          title: "Woken",
          // Wake time already passed: back in the active list.
          snoozedUntil: "2026-06-01T18:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    // Same createdAt → static sort tiebreaks by id; the point is the woken
    // thread is BACK in the card block and the snoozed one is gone.
    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "woken"]);
    expect(layout.snoozedCount).toBe(1);
  });

  it("places settled pinned threads in the settled shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-settled"),
          title: "Pinned while settled",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active", "pinned-settled"]);
    expect(layout.items.map((item) => item.pinned)).toEqual([false, false]);
    expect(layout.settledCount).toBe(1);
  });

  it("keeps active pinned threads in the pinned block", () => {
    const pinned = makeThread({
      id: ThreadId.make("pinned"),
      title: "Pinned thread",
      pinnedAt: "2026-06-01T12:00:00.000Z",
    });
    const layout = buildThreadListV2Items({
      threads: [pinned],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items[0]).toMatchObject({
      thread: { id: "pinned" },
      variant: "card",
      pinned: true,
    });
    expect(layout.settledCount).toBe(0);
  });

  it("snooze hides a pinned thread and wake restores it to the pinned block", () => {
    const snoozedInput = {
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("pinned-snoozed"),
          title: "Pinned and snoozed",
          pinnedAt: "2026-06-01T12:00:00.000Z",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T11:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
    };

    // Before the wake time: the snooze wins; the pin holds underneath.
    const whileSnoozed = buildThreadListV2Items({ ...snoozedInput, now: NOW });
    expect(whileSnoozed.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(whileSnoozed.snoozedCount).toBe(1);

    // After the wake time: the thread returns pinned, back on top.
    const afterWake = buildThreadListV2Items({ ...snoozedInput, now: "2026-06-03T10:00:00.000Z" });
    expect(afterWake.items.map((item) => item.thread.id)).toEqual(["pinned-snoozed", "active"]);
    expect(afterWake.items[0]?.pinned).toBe(true);
    expect(afterWake.snoozedCount).toBe(0);
  });

  it("classifies snooze with the second-precise clock and reports the next wake", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("just-woke"),
          title: "Just woke",
          // Woke 30s ago: hidden under the minute-floored clock, visible
          // under the precise one.
          snoozedUntil: "2026-06-02T00:00:30.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("still-snoozed"),
          title: "Still snoozed",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: "2026-06-02T00:01:07.500Z",
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["just-woke"]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.nextSnoozeWakeAt).toBe("2026-06-02T09:00:00.000Z");
  });

  it("builds snoozed rows between active and settled when the shelf is expanded", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("later"),
          title: "Wakes later",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("sooner"),
          title: "Wakes sooner",
          snoozedUntil: "2026-06-02T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      snoozedShelfExpanded: true,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "sooner",
      "later",
      "settled",
    ]);
    expect(layout.items.map((item) => item.snoozed)).toEqual([false, true, true, false]);
    expect(layout.snoozedShelfHeaderIndex).toBe(1);
    expect(layout.snoozedCount).toBe(2);
  });

  it("collapses to a header-only shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items).toEqual([]);
    expect(layout.snoozedCount).toBe(1);
    expect(layout.snoozedShelfHeaderIndex).toBe(0);
  });

  it("keeps the selected thread on a collapsed shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("open"),
          title: "Open",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          snoozedUntil: "2026-06-03T10:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      selectedThreadKey: `${environmentId}:open`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["open"]);
    expect(layout.items[0]?.snoozed).toBe(true);
    expect(layout.snoozedCount).toBe(2);
  });

  it("keeps snoozed threads visible on environments without the snooze capability", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "Snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      snoozeEnvironmentIds: new Set(),
      now: NOW,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["snoozed"]);
    expect(layout.snoozedCount).toBe(0);
  });

  it("partitions settled threads into a slim shelf", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("settled-2"),
          title: "Settled 2",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(layout.items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["active", "card"],
      ["settled", "slim"],
      ["settled-2", "slim"],
    ]);
    expect(layout.items.map((item) => item.isLast)).toEqual([false, false, true]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("collapses settled threads to a counted shelf header", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "Active" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["active"]);
    expect(layout.settledCount).toBe(1);
    expect(layout.settledShelfHeaderIndex).toBe(1);
  });

  it("keeps the selected settled thread visible when its shelf is collapsed", () => {
    const layout = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("selected"),
          title: "Selected",
          settledOverride: "settled",
          settledAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("other"),
          title: "Other",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
      settledShelfExpanded: false,
      selectedThreadKey: `${environmentId}:selected`,
    });

    expect(layout.items.map((item) => item.thread.id)).toEqual(["selected"]);
    expect(layout.settledCount).toBe(2);
    expect(layout.settledShelfHeaderIndex).toBe(0);
  });

  it("orders active roots by recent activity like the fork sidebar", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("older-created"),
          title: "Older",
          createdAt: "2026-06-01T08:00:00.000Z",
          updatedAt: NOW,
        }),
        makeThread({
          id: ThreadId.make("newer-created"),
          title: "Newer",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["older-created", "newer-created"]);
  });

  it("sorts settled threads by their persisted settlement timestamp", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("settled-newer"),
          title: "Settled newer",
          settledOverride: "settled",
          settledAt: "2026-06-01T12:00:00.000Z",
          latestUserMessageAt: "2026-06-01T08:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled-older"),
          title: "Settled older",
          settledOverride: "settled",
          settledAt: "2026-06-01T10:00:00.000Z",
          latestUserMessageAt: "2026-06-01T09:00:00.000Z",
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["settled-newer", "settled-older"]);
  });

  it("keeps settled threads in the tail and filters by search query", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("match"), title: "Fix login bug" }),
        makeThread({ id: ThreadId.make("miss"), title: "Greeting" }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "Fix login again",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "login",
      now: NOW,
    });

    expect(items.map((item) => [item.thread.id, item.variant])).toEqual([
      ["match", "card"],
      ["settled", "slim"],
    ]);
  });

  it("filters by linked pull request", () => {
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({
          id: ThreadId.make("match"),
          title: "Unrelated title",
          pullRequest: {
            number: 10839,
            url: "https://github.com/pingdotgg/t3code/pull/10839",
            title: "Find linked PR threads",
            baseBranch: "main",
            headBranch: "feat/search",
            state: "open",
          },
        }),
        makeThread({ id: ThreadId.make("miss"), title: "Other work" }),
      ],
      environmentId: null,
      searchQuery: "https://github.com/pingdotgg/t3code/pull/10839?tab=files",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["match"]);
  });

  it("includes a thread matched by message content", () => {
    const thread = makeThread({
      id: ThreadId.make("content-match"),
      title: "Unrelated title",
    });
    const { items } = buildThreadListV2Items({
      threads: [thread],
      environmentId: null,
      searchQuery: "relay reconnect",
      matchedThreadKeys: new Set([
        threadSearchMatchKey({
          environmentId,
          threadId: thread.id,
        }),
      ]),
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["content-match"]);
  });

  it("scopes the flat list to one project", () => {
    const otherProjectId = ProjectId.make("project-2");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("included"), title: "Included" }),
        makeThread({
          id: ThreadId.make("excluded"),
          projectId: otherProjectId,
          title: "Excluded",
        }),
      ],
      environmentId: null,
      projectRefs: [{ environmentId, projectId: ProjectId.make("project-1") }],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["included"]);
  });

  it("scopes the flat list to every environment member of a logical project", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const { items } = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("local"), title: "Local" }),
        makeThread({
          environmentId: remoteEnvironmentId,
          id: ThreadId.make("remote"),
          title: "Remote",
        }),
      ],
      environmentId: null,
      projectRefs: [
        { environmentId, projectId: ProjectId.make("project-1") },
        { environmentId: remoteEnvironmentId, projectId: ProjectId.make("project-1") },
      ],
      searchQuery: "",
      now: NOW,
    });

    expect(items.map((item) => item.thread.id)).toEqual(["local", "remote"]);
  });
});

describe("buildThreadListV2Items settled paging", () => {
  it("caps the settled tail at settledLimit and reports the hidden count", () => {
    const threads = [
      makeThread({ id: ThreadId.make("active"), title: "Active" }),
      ...Array.from({ length: 4 }, (_, index) =>
        makeThread({
          id: ThreadId.make(`settled-${index}`),
          title: `Settled ${index}`,
          settledOverride: "settled",
          settledAt: `2026-06-01T0${index}:10:00.000Z`,
          latestUserMessageAt: `2026-06-01T0${index}:00:00.000Z`,
          // A turn adopted the message (same requestedAt): without it the
          // thread reads as a queued turn start, which never settles.
          latestTurn: {
            turnId: TurnId.make(`turn-${index}`),
            state: "completed",
            requestedAt: `2026-06-01T0${index}:00:00.000Z`,
            startedAt: `2026-06-01T0${index}:00:00.000Z`,
            completedAt: `2026-06-01T0${index}:10:00.000Z`,
            assistantMessageId: null,
          },
        }),
      ),
    ];

    const layout = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      settledLimit: 2,
      now: NOW,
    });

    expect(layout.hiddenSettledCount).toBe(2);
    expect(layout.items.filter((item) => item.variant === "slim")).toHaveLength(2);
    // Most recent settled first — the hidden ones are the oldest.
    expect(layout.items.map((item) => item.thread.id)).toEqual([
      "active",
      "settled-3",
      "settled-2",
    ]);
  });
});

function makePendingTask(id: string): PendingNewTask {
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId,
    projectId: ProjectId.make("project-1"),
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    createdAt: NOW,
    message: {
      environmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: null,
        worktreePath: null,
      },
    },
    creation: {
      projectId: ProjectId.make("project-1"),
      workspaceMode: "worktree",
      branch: null,
      worktreePath: null,
    },
    title: id,
  };
}

describe("buildThreadListV2ListItems", () => {
  const layout = buildThreadListV2Items({
    threads: [
      makeThread({ id: ThreadId.make("active"), title: "active" }),
      makeThread({
        id: ThreadId.make("settled"),
        title: "settled",
        settledOverride: "settled",
        settledAt: NOW,
      }),
    ],
    environmentId: null,
    searchQuery: "",
    now: NOW,
  });

  it("splices queued tasks between the active block and the settled tail", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [makePendingTask("queued-1"), makePendingTask("queued-2")],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(
      items.map((item) =>
        item.type === "v2-pending"
          ? item.pendingTask.title
          : item.type === "v2-thread"
            ? item.item.thread.id
            : item.type === "v2-snoozed-shelf"
              ? "snoozed-shelf"
              : "settled-shelf",
      ),
    ).toEqual(["active", "queued-1", "queued-2", "settled-shelf", "settled"]);
    // Only the leading queued row labels the section, exactly like Settled.
    expect(
      items.filter((item) => item.type === "v2-pending" && item.showPendingDivider),
    ).toHaveLength(1);
  });

  it("ends the list with queued tasks when nothing has settled yet", () => {
    const activeOnly = buildThreadListV2Items({
      threads: [makeThread({ id: ThreadId.make("active"), title: "active" })],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: activeOnly.items,
      pendingTasks: [makePendingTask("queued-1")],
    });

    expect(items.map((item) => item.type)).toEqual(["v2-thread", "v2-pending"]);
  });

  it("keeps the settled shelf between active and settled rows when nothing is queued", () => {
    const items = buildThreadListV2ListItems({
      items: layout.items,
      pendingTasks: [],
      settledCount: layout.settledCount,
      settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.key)).toEqual([
      `v2-thread:${environmentId}:active`,
      "v2-settled-shelf",
      `v2-thread:${environmentId}:settled`,
    ]);
  });

  it("places queued tasks before a collapsed snoozed shelf", () => {
    const snoozedLayout = buildThreadListV2Items({
      threads: [
        makeThread({ id: ThreadId.make("active"), title: "active" }),
        makeThread({
          id: ThreadId.make("snoozed"),
          title: "snoozed",
          snoozedUntil: "2026-06-03T09:00:00.000Z",
          snoozedAt: "2026-06-01T12:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("settled"),
          title: "settled",
          settledOverride: "settled",
          settledAt: NOW,
        }),
      ],
      environmentId: null,
      searchQuery: "",
      now: NOW,
    });
    const items = buildThreadListV2ListItems({
      items: snoozedLayout.items,
      pendingTasks: [makePendingTask("queued")],
      snoozedCount: snoozedLayout.snoozedCount,
      snoozedShelfExpanded: false,
      snoozedShelfHeaderIndex: snoozedLayout.snoozedShelfHeaderIndex,
      settledCount: snoozedLayout.settledCount,
      settledShelfHeaderIndex: snoozedLayout.settledShelfHeaderIndex,
    });

    expect(items.map((item) => item.type)).toEqual([
      "v2-thread",
      "v2-pending",
      "v2-snoozed-shelf",
      "v2-settled-shelf",
      "v2-thread",
    ]);
  });
});

describe("threadListV2ItemsAreEqual", () => {
  const thread = makeThread({ id: ThreadId.make("equal-row"), title: "Row" });
  const hierarchy = (overrides: Partial<MobileThreadTreeRow> = {}): MobileThreadTreeRow => ({
    thread,
    threadKey: "environment-1:equal-row",
    depth: 0,
    hasChildren: true,
    isExpanded: true,
    childCount: 1,
    displayStatus: "ready",
    archiveBlocked: false,
    ...overrides,
  });
  const threadItem = (
    hierarchyOverrides: Partial<MobileThreadTreeRow> = {},
    itemOverrides: Partial<ThreadListV2Item> = {},
  ): ThreadListV2ListItem => ({
    type: "v2-thread",
    key: "v2-thread:environment-1:equal-row",
    item: {
      thread,
      hierarchy: hierarchy(hierarchyOverrides),
      status: "ready",
      variant: "card",
      snoozed: false,
      pinned: false,
      isLast: false,
      ...itemOverrides,
    },
    snoozeWakeLabelText: undefined,
  });

  it("treats fresh-but-identical rows as equal so toggles skip unchanged rows", () => {
    // Layout rebuilds mint new objects on every toggle; the equality must
    // see through that to the consumed fields.
    expect(threadListV2ItemsAreEqual(threadItem(), threadItem())).toBe(true);
  });

  it("notices collapse, status, and thread changes", () => {
    expect(threadListV2ItemsAreEqual(threadItem(), threadItem({ isExpanded: false }))).toBe(false);
    expect(threadListV2ItemsAreEqual(threadItem(), threadItem({}, { status: "working" }))).toBe(
      false,
    );
    expect(
      threadListV2ItemsAreEqual(
        threadItem(),
        threadItem(
          {},
          {
            thread: makeThread({ id: ThreadId.make("other-row"), title: "Other" }),
          },
        ),
      ),
    ).toBe(false);
  });

  it("compares shelves and pending rows by their consumed fields", () => {
    const shelf: ThreadListV2ListItem = {
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: 2,
      expanded: false,
    };
    expect(threadListV2ItemsAreEqual(shelf, { ...shelf })).toBe(true);
    expect(threadListV2ItemsAreEqual(shelf, { ...shelf, count: 3 })).toBe(false);
    expect(threadListV2ItemsAreEqual(shelf, { ...shelf, expanded: true })).toBe(false);
    expect(threadListV2ItemsAreEqual(threadItem(), shelf)).toBe(false);
    expect(threadListV2ItemsAreEqual(shelf, threadItem())).toBe(false);
  });
});

describe("threadListV2 toggle invalidation scope", () => {
  const top = makeThread({ id: ThreadId.make("scope-top"), title: "Top" });
  const mid = makeThread({ id: ThreadId.make("scope-mid"), title: "Mid" });
  const childA = makeThread({
    id: ThreadId.make("scope-child-a"),
    title: "Child A",
    parentThreadId: mid.id,
  });
  const childB = makeThread({
    id: ThreadId.make("scope-child-b"),
    title: "Child B",
    parentThreadId: mid.id,
  });
  const bottom = makeThread({ id: ThreadId.make("scope-bottom"), title: "Bottom" });
  const threads = [top, mid, childA, childB, bottom];
  const toListItems = (collapsedThreadKeys: ReadonlySet<string>): ThreadListV2ListItem[] => {
    const scoped = buildThreadListV2Items({
      threads,
      environmentId: null,
      searchQuery: "",
      now: NOW,
      collapsedThreadKeys,
    });
    return buildThreadListV2ListItems({
      items: scoped.items,
      pendingTasks: [],
      snoozedCount: scoped.snoozedCount,
      snoozedShelfHeaderIndex: scoped.snoozedShelfHeaderIndex,
      settledCount: scoped.settledCount,
      settledShelfHeaderIndex: scoped.settledShelfHeaderIndex,
    });
  };

  it("invalidates only the toggled parent row on collapse", () => {
    const before = toListItems(new Set());
    const after = toListItems(new Set([`${environmentId}:scope-mid`]));
    expect(before.map((item) => item.key)).toEqual([
      // Same timestamps sort by id: bottom, mid (+ children), top.
      "v2-thread:environment-1:scope-bottom",
      "v2-thread:environment-1:scope-mid",
      "v2-thread:environment-1:scope-child-a",
      "v2-thread:environment-1:scope-child-b",
      "v2-thread:environment-1:scope-top",
    ]);
    expect(after.map((item) => item.key)).toEqual([
      "v2-thread:environment-1:scope-bottom",
      "v2-thread:environment-1:scope-mid",
      "v2-thread:environment-1:scope-top",
    ]);
    const beforeByKey = new Map(before.map((item) => [item.key, item]));
    for (const item of after) {
      const previous = beforeByKey.get(item.key);
      expect(previous).toBeDefined();
      // Only the collapsed parent flips equality; siblings above and below
      // keep every consumed field, so the recycled list reuses their views.
      expect(threadListV2ItemsAreEqual(previous as ThreadListV2ListItem, item)).toBe(
        item.key !== "v2-thread:environment-1:scope-mid",
      );
    }
  });
});

describe("resolveThreadListV2RootState", () => {
  const settled = makeThread({
    id: ThreadId.make("settled"),
    title: "Settled",
    settledOverride: "settled",
    settledAt: NOW,
  });
  const base = {
    relatedStatus: "ready" as const,
    settlementSupported: true,
    snoozeSupported: true,
    now: NOW,
  };

  it("classifies a settled ready thread as a slim shelf row", () => {
    expect(resolveThreadListV2RootState({ thread: settled, ...base })).toEqual({
      variant: "slim",
      snoozed: false,
      pinned: false,
    });
  });

  it("keeps a settled thread on a card while its group is busy", () => {
    expect(
      resolveThreadListV2RootState({ thread: settled, ...base, relatedStatus: "working" }),
    ).toEqual({ variant: "card", snoozed: false, pinned: false });
  });

  it("keeps a settled thread on a card when unread descendant activity promotes it", () => {
    expect(
      resolveThreadListV2RootState({ thread: settled, ...base, hasUnreadDescendant: true }),
    ).toEqual({ variant: "card", snoozed: false, pinned: false });
  });

  it("keeps threads on a card where settlement is unsupported", () => {
    expect(
      resolveThreadListV2RootState({ thread: settled, ...base, settlementSupported: false }),
    ).toEqual({ variant: "card", snoozed: false, pinned: false });
  });

  it("classifies a snoozed ready thread as a slim snoozed row", () => {
    const snoozed = makeThread({
      id: ThreadId.make("snoozed"),
      title: "Snoozed",
      snoozedUntil: "2026-06-03T09:00:00.000Z",
      snoozedAt: "2026-06-01T12:00:00.000Z",
    });
    expect(resolveThreadListV2RootState({ thread: snoozed, ...base })).toEqual({
      variant: "slim",
      snoozed: true,
      pinned: false,
    });
  });
});

describe("resolveDaysDraftCommit", () => {
  const bounds = { minDays: 1, maxDays: 90 };
  it.each([
    { draft: "2", current: null, expected: 2 },
    { draft: " 7 ", current: null, expected: 7 },
    { draft: "90", current: 2, expected: 90 },
  ])("commits valid draft $draft", ({ draft, current, expected }) => {
    expect(resolveDaysDraftCommit({ draft, current, ...bounds })).toBe(expected);
  });
  it.each([
    { draft: "2", current: 2 },
    { draft: "3.5", current: null },
    { draft: "3days", current: null },
    { draft: "", current: null },
    { draft: null, current: null },
    { draft: "0", current: null },
    { draft: "91", current: null },
    { draft: "-3", current: null },
  ])("rejects draft $draft without a write", ({ draft, current }) => {
    expect(resolveDaysDraftCommit({ draft, current, ...bounds })).toBeNull();
  });
});
