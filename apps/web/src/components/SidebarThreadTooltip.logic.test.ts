import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { sidebarThreadKey } from "../sidebarThreadTree";
import type { SidebarThreadSummary } from "../types";
import {
  buildThreadTooltipActivity,
  selectThreadTooltipChildren,
} from "./SidebarThreadTooltip.logic";

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    parentThreadId: null,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasPendingQueuedTurn: false,
    ...overrides,
  };
}

const completedTurn: NonNullable<SidebarThreadSummary["latestTurn"]> = {
  turnId: TurnId.make("turn"),
  state: "completed",
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-02T00:00:00.000Z",
  assistantMessageId: null,
};

const parent = thread("parent");
const defaults = {
  thread: parent,
  lastVisitedAtByThreadKey: {},
  pendingThreadKeys: new Set<string>(),
};

describe("selectThreadTooltipChildren", () => {
  it("counts direct, visible children, including virtual agent runs, within their environment", () => {
    const child = thread("child", { parentThreadId: parent.id });
    const agent = thread("agent", {
      parentThreadId: parent.id,
      virtualAgentRun: { parentThreadId: parent.id, taskId: "task", status: "running" },
    });
    const threads = [
      parent,
      child,
      agent,
      thread("grandchild", { parentThreadId: child.id }),
      thread("archived", { parentThreadId: parent.id, archivedAt: parent.updatedAt ?? null }),
      thread("other-environment", {
        parentThreadId: parent.id,
        environmentId: EnvironmentId.make("remote"),
      }),
    ];
    expect(selectThreadTooltipChildren(threads, sidebarThreadKey(parent))).toEqual([child, agent]);
  });

  it("suppresses children of archived ancestors and normalizes self-parent links", () => {
    const archived = thread("ancestor", { archivedAt: "2026-01-02T00:00:00.000Z" });
    const hiddenParent = thread("parent", { parentThreadId: archived.id });
    const child = thread("child", { parentThreadId: parent.id });
    expect(
      selectThreadTooltipChildren([archived, hiddenParent, child], sidebarThreadKey(parent)),
    ).toEqual([]);
    expect(
      selectThreadTooltipChildren(
        [{ ...parent, parentThreadId: parent.id }, child],
        sidebarThreadKey(parent),
      ),
    ).toEqual([child]);
  });
});

describe("buildThreadTooltipActivity", () => {
  it("puts blockers before work and completed children, caps the preview at three", () => {
    const children = [
      thread("done", { latestTurn: completedTurn }),
      thread("working", { hasPendingQueuedTurn: true }),
      thread("input", { hasPendingUserInput: true }),
      thread("approval", { hasPendingApprovals: true }),
      thread("idle"),
    ];
    const activity = buildThreadTooltipActivity({ ...defaults, children });
    expect(activity.childCount).toBe(5);
    expect(activity.children.map((child) => child.status)).toEqual([
      "approval",
      "input",
      "working",
    ]);
    expect(activity.remainingChildCount).toBe(2);
    expect(activity.unreadResultCount).toBe(1);
  });

  it("counts unseen successful results across the entire list and clears them after a visit", () => {
    const done = thread("done", { latestTurn: completedTurn });
    const failed = thread("failed", { latestTurn: { ...completedTurn, state: "error" } });
    const stopped = thread("stopped", { latestTurn: { ...completedTurn, state: "interrupted" } });
    const children = [done, failed, stopped];
    expect(buildThreadTooltipActivity({ ...defaults, children }).unreadResultCount).toBe(1);
    const read = buildThreadTooltipActivity({
      ...defaults,
      children,
      lastVisitedAtByThreadKey: { [sidebarThreadKey(done)]: completedTurn.completedAt! },
    });
    expect(read.unreadResultCount).toBe(0);
    expect(read.children.map((child) => child.status)).toEqual(["failed", "done", "stopped"]);
  });

  it("uses the parent visit for virtual results and preserves failed/stopped agent states", () => {
    const children = (["completed", "failed", "stopped"] as const).map((status) =>
      thread(status, {
        virtualAgentRun: { parentThreadId: parent.id, taskId: status, status },
      }),
    );
    expect(buildThreadTooltipActivity({ ...defaults, children }).unreadResultCount).toBe(1);
    const read = buildThreadTooltipActivity({
      ...defaults,
      children,
      lastVisitedAtByThreadKey: { [sidebarThreadKey(parent)]: "2026-01-03T00:00:00.000Z" },
    });
    expect(read.unreadResultCount).toBe(0);
    expect(read.children.map((child) => child.status)).toEqual(["failed", "done", "stopped"]);
  });

  it("keeps pending and handoff turns working instead of showing old results as unread", () => {
    const optimistic = thread("optimistic", { latestTurn: completedTurn });
    const handoff = thread("handoff", { latestTurn: completedTurn, hasPendingQueuedTurn: true });
    const activity = buildThreadTooltipActivity({
      ...defaults,
      children: [optimistic, handoff],
      pendingThreadKeys: new Set([sidebarThreadKey(optimistic)]),
    });
    expect(activity.children.every((child) => child.status === "working")).toBe(true);
    expect(activity.unreadResultCount).toBe(0);
  });

  it.each([
    [{ hasPendingApprovals: true }, "Waiting for approval"],
    [{ hasPendingUserInput: true }, "Waiting for your answer"],
    [
      { interactionMode: "plan", hasActionableProposedPlan: true, latestTurn: completedTurn },
      "Plan ready for review",
    ],
    [{ latestTurn: { ...completedTurn, state: "error" } }, "Thread needs attention"],
  ] satisfies Array<[Partial<SidebarThreadSummary>, string]>)(
    "shows actionable parent blockers",
    (overrides, blocker) => {
      expect(
        buildThreadTooltipActivity({
          ...defaults,
          thread: thread("parent", overrides),
          children: [],
        }).blocker,
      ).toBe(blocker);
    },
  );

  it("tracks the parent's durable child notification independently of child result visits", () => {
    const updatedParent = thread("parent", {
      latestChildNotificationAt: "2026-01-03T00:00:00.000Z",
    });
    expect(
      buildThreadTooltipActivity({ ...defaults, thread: updatedParent, children: [] })
        .hasUnreadChildUpdate,
    ).toBe(true);
    expect(
      buildThreadTooltipActivity({
        ...defaults,
        thread: updatedParent,
        children: [],
        lastVisitedAtByThreadKey: { [sidebarThreadKey(parent)]: "2026-01-03T00:00:00.000Z" },
      }).hasUnreadChildUpdate,
    ).toBe(false);
  });
});
