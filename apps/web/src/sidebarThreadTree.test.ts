import {
  EnvironmentId,
  EventId,
  type OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { ThreadStatusPill } from "./components/Sidebar.logic";
import {
  agentRunDismissKey,
  buildSidebarThreadRows,
  deriveSidebarThreadsWithAgentRuns,
  expandSidebarThreadsWithAgentRuns,
  isThreadInSubtree,
  selectVisibleSidebarThreads,
} from "./sidebarThreadTree";
import type { AgentRun } from "./session-logic";
import type { SidebarThreadSummary } from "./types";

const environmentId = EnvironmentId.make("env-a");
const projectId = ProjectId.make("project-a");

function key(id: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, id));
}

function thread(id: string, input: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    environmentId,
    projectId,
    parentThreadId: null,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: `2026-01-01T00:00:0${id.at(-1) ?? "0"}.000Z`,
    archivedAt: null,
    updatedAt: `2026-01-01T00:00:0${id.at(-1) ?? "0"}.000Z`,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

const workingStatus: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-sky-600",
  dotClass: "bg-sky-500",
  pulse: true,
  dotOnly: true,
};

function activity(
  overrides: Omit<
    Pick<OrchestrationThreadActivity, "id" | "createdAt" | "kind" | "summary" | "tone">,
    "id"
  > & { id: string; payload: Record<string, unknown> },
): OrchestrationThreadActivity {
  return {
    ...overrides,
    id: EventId.make(overrides.id),
    turnId: null,
  };
}

describe("buildSidebarThreadRows", () => {
  it("renders inactive background agents through the normal nested-chat tree", () => {
    const parent = thread("thread-1");
    const agentRun: AgentRun = {
      taskId: "agent-1",
      name: "Repository explorer",
      startedAt: "2026-01-01T00:00:02.000Z",
      status: "completed",
      entries: [],
    };
    const threads = expandSidebarThreadsWithAgentRuns({
      threads: [parent],
      agentRunsByThreadKey: new Map([[key(parent.id), [agentRun]]]),
    });

    const result = buildSidebarThreadRows({
      threads,
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map([[key(parent.id), true]]),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => [row.thread.title, row.depth])).toEqual([
      [parent.title, 0],
      [agentRun.name, 1],
    ]);
    expect(result.rowViews[0]).toMatchObject({ hasChildren: true, childCount: 1 });
    expect(result.rowViews[1]?.thread.virtualAgentRun).toEqual({
      parentThreadId: parent.id,
      taskId: agentRun.taskId,
      status: "completed",
    });
  });

  it("omits dismissed background-agent runs", () => {
    const parent = thread("thread-1");
    const dismissedRun: AgentRun = {
      taskId: "agent-dismissed",
      name: "Dismissed run",
      startedAt: "2026-01-01T00:00:02.000Z",
      status: "completed",
      entries: [],
    };
    const visibleRun: AgentRun = {
      ...dismissedRun,
      taskId: "agent-visible",
      name: "Visible run",
    };

    const threads = expandSidebarThreadsWithAgentRuns({
      threads: [parent],
      agentRunsByThreadKey: new Map([[key(parent.id), [dismissedRun, visibleRun]]]),
      dismissedAgentRunKeys: {
        [agentRunDismissKey(parent.id, dismissedRun.taskId)]: true,
      },
    });

    expect(threads.map((candidate) => candidate.title)).toEqual([parent.title, visibleRun.name]);
  });

  it("derives and dismisses background-agent runs from sidebar activities", () => {
    const parent = thread("thread-1");
    const start = activity({
      id: "agent-start",
      createdAt: "2026-01-01T00:00:02.000Z",
      kind: "task.started",
      summary: "Repository explorer",
      tone: "info",
      payload: {
        taskId: "agent-1",
        taskType: "background-agent",
        name: "Repository explorer",
      },
    });

    const visible = deriveSidebarThreadsWithAgentRuns({
      threads: [parent],
      threadActivities: [[start]],
    });
    const dismissed = deriveSidebarThreadsWithAgentRuns({
      threads: [parent],
      threadActivities: [[start]],
      dismissedAgentRunKeys: {
        [agentRunDismissKey(parent.id, "agent-1")]: true,
      },
    });

    expect(visible.map((candidate) => candidate.title)).toEqual([
      parent.title,
      "Repository explorer",
    ]);
    expect(dismissed).toEqual([parent]);
  });

  it("does not resurrect agent runs from archived parent threads", () => {
    const archivedParent = thread("thread-1", {
      archivedAt: "2026-01-01T00:00:03.000Z",
    });
    const agentRun: AgentRun = {
      taskId: "agent-archived",
      name: "Archived nested run",
      startedAt: "2026-01-01T00:00:02.000Z",
      status: "completed",
      entries: [],
    };

    const visibleThreads = expandSidebarThreadsWithAgentRuns({
      threads: [archivedParent],
      agentRunsByThreadKey: new Map([[key(archivedParent.id), [agentRun]]]),
    }).filter((candidate) => candidate.archivedAt === null);

    expect(visibleThreads).toEqual([]);
  });

  it("does not promote historical descendants of archived threads to roots", () => {
    const archivedParent = thread("thread-1", {
      archivedAt: "2026-01-01T00:00:04.000Z",
    });
    const child = thread("thread-2", { parentThreadId: archivedParent.id });
    const grandchild = thread("thread-3", { parentThreadId: child.id });
    const unrelatedOrphan = thread("thread-4", {
      parentThreadId: ThreadId.make("missing"),
    });

    expect(
      selectVisibleSidebarThreads([archivedParent, child, grandchild, unrelatedOrphan]).map(
        (candidate) => candidate.id,
      ),
    ).toEqual([unrelatedOrphan.id]);
  });

  it("recognizes a nested chat as part of its parent subtree", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });
    const grandchild = thread("thread-3", { parentThreadId: child.id });
    const unrelated = thread("thread-4");

    expect(
      isThreadInSubtree([parent, child, grandchild, unrelated], parent.id, grandchild.id),
    ).toBe(true);
    expect(isThreadInSubtree([parent, child, grandchild, unrelated], parent.id, unrelated.id)).toBe(
      false,
    );
  });

  it("renders child chats indented directly below expanded parents", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });
    const grandchild = thread("thread-3", { parentThreadId: child.id });

    const result = buildSidebarThreadRows({
      threads: [grandchild, child, parent],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map([
        [key(parent.id), true],
        [key(child.id), true],
      ]),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => [row.thread.id, row.depth])).toEqual([
      [parent.id, 0],
      [child.id, 1],
      [grandchild.id, 2],
    ]);
    expect(result.orderedThreadKeys).toEqual([key(parent.id), key(child.id), key(grandchild.id)]);
  });

  it("collapses settled parents by default so nested chats stay hidden", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });

    const result = buildSidebarThreadRows({
      threads: [parent, child],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map(),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([parent.id]);
    expect(result.rowViews[0]).toMatchObject({ hasChildren: true, isExpanded: false });
  });

  it("keeps an unseen completed nested chat visible", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });
    const completedStatus: ThreadStatusPill = {
      label: "Completed",
      colorClass: "text-emerald-600",
      dotClass: "bg-emerald-500",
      pulse: false,
      dotOnly: true,
    };

    const result = buildSidebarThreadRows({
      threads: [parent, child],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map(),
      sortOrder: "created_at",
      resolveThreadStatus: (candidate) => (candidate.id === child.id ? completedStatus : null),
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([parent.id, child.id]);
    expect(result.rowViews[0]).toMatchObject({ hasChildren: true, isExpanded: true });

    const manuallyCollapsed = buildSidebarThreadRows({
      threads: [parent, child],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map([[key(parent.id), false]]),
      sortOrder: "created_at",
      resolveThreadStatus: (candidate) => (candidate.id === child.id ? completedStatus : null),
    });

    expect(manuallyCollapsed.rowViews.map((row) => row.thread.id)).toEqual([parent.id, child.id]);
  });

  it("keeps the active settled child and its ancestors visible", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });
    const grandchild = thread("thread-3", { parentThreadId: child.id });

    const result = buildSidebarThreadRows({
      threads: [parent, child, grandchild],
      pinnedThreadKeys: [],
      activeThreadKey: key(grandchild.id),
      expandedOverrideByThreadKey: new Map([
        [key(parent.id), false],
        [key(child.id), false],
      ]),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([
      parent.id,
      child.id,
      grandchild.id,
    ]);
  });

  it("auto-expands parents whose descendants are active", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });

    const result = buildSidebarThreadRows({
      threads: [parent, child],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map(),
      sortOrder: "created_at",
      resolveThreadStatus: (candidate) => (candidate.id === child.id ? workingStatus : null),
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([parent.id, child.id]);
    expect(result.rowViews[0]?.isExpanded).toBe(true);
  });

  it("keeps active descendants visible after their parent is explicitly collapsed", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });

    const result = buildSidebarThreadRows({
      threads: [parent, child],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map([[key(parent.id), false]]),
      sortOrder: "created_at",
      resolveThreadStatus: (candidate) => (candidate.id === child.id ? workingStatus : null),
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([parent.id, child.id]);
    expect(result.rowViews[0]?.childCount).toBe(1);
    expect(result.rowViews[0]?.rolledUpStatus?.label).toBe("Working");
    expect(result.projectStatus?.label).toBe("Working");
  });

  it("treats missing parents as roots", () => {
    const orphan = thread("thread-1", { parentThreadId: ThreadId.make("missing") });

    const result = buildSidebarThreadRows({
      threads: [orphan],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map(),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => [row.thread.id, row.depth])).toEqual([[orphan.id, 0]]);
  });

  it("breaks cycles defensively instead of dropping threads", () => {
    const first = thread("thread-1", { parentThreadId: ThreadId.make("thread-2") });
    const second = thread("thread-2", { parentThreadId: first.id });

    const result = buildSidebarThreadRows({
      threads: [first, second],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map([
        [key(first.id), true],
        [key(second.id), true],
      ]),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => row.thread.id).toSorted()).toEqual(
      [first.id, second.id].toSorted(),
    );
  });

  it("pins root threads without pinning nested children above their parent", () => {
    const root1 = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: root1.id });
    const root2 = thread("thread-3");

    const result = buildSidebarThreadRows({
      threads: [root1, child, root2],
      pinnedThreadKeys: [key(root2.id), key(child.id)],
      expandedOverrideByThreadKey: new Map([[key(root1.id), true]]),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([root2.id, root1.id, child.id]);
  });
});
