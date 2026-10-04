import { describe, expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { makeThreadFixture } from "../../test-fixtures";
import { classifyDashboardThread, dashboardThreadMatches } from "./agentDashboard";

describe("agent dashboard", () => {
  const thread = makeThreadFixture();
  it("presents shell previews without requiring a full message or thread detail", () => {
    const hydrated = presentThreadShell(thread.environmentId, {
      ...thread.source,
      latestVisibleMessage: null,
      recentMessagePreview: "Fixing the parser",
    });
    expect(hydrated.recentMessage).toBe("Fixing the parser");
    const updated = presentThreadShell(thread.environmentId, {
      ...hydrated.source,
      recentMessagePreview: "Parser tests now pass",
    });
    expect(updated.recentMessage).toBe("Parser tests now pass");
    const legacy = { ...thread.source };
    delete legacy.recentMessagePreview;
    expect(presentThreadShell(thread.environmentId, legacy).recentMessage).toBe("");
  });
  const completed = {
    ...thread,
    latestRun: {
      runId: RunId.make("run"),
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-10-03T00:00:00Z",
      assistantMessageId: null,
    },
  };
  it("never calls a disconnected completion Done", () => {
    expect(classifyDashboardThread(completed, false)).toEqual({
      column: "Needs You",
      label: "Disconnected · status unknown",
    });
    expect(classifyDashboardThread({ ...completed, runtime: null }, true).column).toBe("Done");
  });
  it("prioritizes permission and question requests over execution", () => {
    expect(classifyDashboardThread({ ...thread, hasPendingApprovals: true }).label).toBe(
      "Approval requested",
    );
    expect(classifyDashboardThread({ ...thread, hasPendingUserInput: true }).label).toBe(
      "Question unanswered",
    );
  });
  it.each(["failed", "interrupted", "cancelled"] as const)(
    "keeps %s stops in Needs You",
    (status) => {
      expect(
        classifyDashboardThread({
          ...completed,
          runtime: null,
          latestRun: { ...completed.latestRun, status },
        }).column,
      ).toBe("Needs You");
    },
  );
  it("does not complete a parent with pending delegated work", () => {
    expect(
      classifyDashboardThread({
        ...completed,
        runtime: null,
        pendingBackgroundTasks: [{ kind: "subagent", taskId: "child" }],
      }).column,
    ).toBe("Working");
  });
  it("scopes project filters by environment and matches provider and workspace", () => {
    const candidate = { ...thread, title: "Fix parser", branch: "bug/parser" };
    const filters = { search: "parser", project: "", workspace: "bug/", pullRequest: "" };
    expect(dashboardThreadMatches(candidate, filters, "T3")).toBe(true);
    expect(
      dashboardThreadMatches(candidate, { ...filters, environment: "somewhere-else" }, "T3"),
    ).toBe(false);
    expect(dashboardThreadMatches(candidate, { ...filters, provider: "other" }, "T3")).toBe(false);
  });
});

import { dashboardEntries, dashboardThreadTarget } from "./agentDashboard";
import { ThreadId } from "@t3tools/contracts";
it("groups a child once under its parent and surfaces child attention", () => {
  const parent = makeThreadFixture();
  const child = {
    ...makeThreadFixture(),
    id: ThreadId.make("child"),
    hasPendingUserInput: true,
    lineage: {
      ...parent.lineage,
      parentThreadId: parent.id,
      relationshipToParent: "subagent" as const,
    },
  };
  const entries = dashboardEntries([parent, child], new Set([parent.environmentId]));
  expect(entries).toHaveLength(1);
  expect(entries[0]?.children.map((entry) => entry.thread.id)).toEqual([child.id]);
  expect(entries[0]?.state.column).toBe("Needs You");
  expect(dashboardThreadTarget(child).params).toEqual({
    environmentId: child.environmentId,
    threadId: child.id,
  });
});
