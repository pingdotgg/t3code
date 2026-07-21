import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { ThreadStatusPill } from "./components/Sidebar.logic";
import {
  agentRunDismissKey,
  buildSidebarThreadRows,
  expandSidebarThreadsWithAgentRuns,
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
};

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

  it("keeps the active settled child and its ancestors visible", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });
    const grandchild = thread("thread-3", { parentThreadId: child.id });

    const result = buildSidebarThreadRows({
      threads: [parent, child, grandchild],
      pinnedThreadKeys: [],
      activeThreadKey: key(grandchild.id),
      expandedOverrideByThreadKey: new Map(),
      sortOrder: "created_at",
      resolveThreadStatus: () => null,
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([
      parent.id,
      child.id,
      grandchild.id,
    ]);
  });

  it("omits collapsed descendants while rolling up their status", () => {
    const parent = thread("thread-1");
    const child = thread("thread-2", { parentThreadId: parent.id });

    const result = buildSidebarThreadRows({
      threads: [parent, child],
      pinnedThreadKeys: [],
      expandedOverrideByThreadKey: new Map([[key(parent.id), false]]),
      sortOrder: "created_at",
      resolveThreadStatus: (candidate) => (candidate.id === child.id ? workingStatus : null),
    });

    expect(result.rowViews.map((row) => row.thread.id)).toEqual([parent.id]);
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
