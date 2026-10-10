import type { TaskGraph, TaskGraphNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveTaskGraphSegment,
  sortTaskGraphs,
  taskGraphActions,
  taskGraphNodeActions,
  taskGraphNodeWaitDetail,
  taskGraphSummaryLabel,
} from "./task-graph-presentation";

const node = (key: string, status: TaskGraphNode["status"], dependsOn: string[] = []) =>
  ({ key, status, dependsOn, title: key }) as unknown as TaskGraphNode;

const graph = (
  status: TaskGraph["status"],
  nodes: TaskGraphNode[],
  overrides: Partial<TaskGraph> = {},
) =>
  ({
    id: `graph-${status}`,
    title: "Ship auth",
    status,
    nodes,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }) as unknown as TaskGraph;

describe("taskGraphSummaryLabel", () => {
  it("counts finished tasks while running", () => {
    expect(
      taskGraphSummaryLabel(
        graph("running", [node("a", "succeeded"), node("b", "running"), node("c", "pending")]),
      ),
    ).toBe("Running · 1 of 3 done");
  });

  it("counts waiting tasks while running", () => {
    expect(
      taskGraphSummaryLabel(graph("running", [node("a", "succeeded"), node("b", "waiting")])),
    ).toBe("Running · 1 of 2 done · 1 waiting");
  });

  it("names failures on a failed graph", () => {
    expect(
      taskGraphSummaryLabel(graph("failed", [node("a", "failed"), node("b", "skipped", ["a"])])),
    ).toBe("Failed · 1 failed");
  });

  it("counts tasks on a draft", () => {
    expect(taskGraphSummaryLabel(graph("draft", [node("a", "pending")]))).toBe("Draft · 1 task");
  });
});

describe("resolveTaskGraphSegment", () => {
  it("is absent without graphs", () => {
    expect(resolveTaskGraphSegment(null)).toBeNull();
    expect(resolveTaskGraphSegment([])).toBeNull();
  });

  it("prefers an open graph over a newer finished one", () => {
    const segment = resolveTaskGraphSegment([
      graph("succeeded", [node("a", "succeeded")], { updatedAt: "2026-10-09T00:00:00.000Z" }),
      graph("running", [node("a", "succeeded"), node("b", "running")]),
    ]);
    expect(segment).toMatchObject({ label: "Graph 1/2", tone: "working" });
  });

  it("stays reachable once every graph has finished", () => {
    expect(resolveTaskGraphSegment([graph("failed", [node("a", "failed")])])).toMatchObject({
      label: "Graph failed",
      tone: "failed",
    });
  });

  it("counts several open graphs", () => {
    expect(
      resolveTaskGraphSegment([
        graph("draft", [node("a", "pending")]),
        graph("running", [node("a", "running")]),
      ])?.label,
    ).toBe("2 graphs");
  });
});

describe("sortTaskGraphs", () => {
  it("puts running before draft before finished, newest first within each", () => {
    const sorted = sortTaskGraphs([
      graph("succeeded", [], { id: "old" as never, updatedAt: "2026-10-01T00:00:00.000Z" }),
      graph("draft", [], { id: "draft" as never }),
      graph("failed", [], { id: "new" as never, updatedAt: "2026-10-05T00:00:00.000Z" }),
      graph("running", [], { id: "running" as never }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["running", "draft", "new", "old"]);
  });
});

describe("taskGraphActions", () => {
  it("runs only drafts and cancels only open graphs", () => {
    expect(taskGraphActions({ status: "draft" })).toEqual({ run: true, cancel: true });
    expect(taskGraphActions({ status: "running" })).toEqual({ run: false, cancel: true });
    expect(taskGraphActions({ status: "failed" })).toEqual({ run: false, cancel: false });
  });
});

describe("taskGraphNodeActions", () => {
  it("cancels the branch of unfinished nodes in an open graph", () => {
    const nodes = [node("a", "running"), node("b", "pending", ["a"])];
    expect(taskGraphNodeActions(graph("running", nodes), nodes[0]!)).toEqual({
      cancelBranch: true,
      retry: false,
    });
    expect(taskGraphNodeActions(graph("running", nodes), nodes[1]!).cancelBranch).toBe(true);
  });

  it("cancels the branch of a waiting node, started or not", () => {
    const nodes = [node("a", "waiting")];
    expect(taskGraphNodeActions(graph("running", nodes), nodes[0]!)).toEqual({
      cancelBranch: true,
      retry: false,
    });
  });

  it("retries failed nodes, including in a finished graph", () => {
    const nodes = [node("a", "failed")];
    expect(taskGraphNodeActions(graph("failed", nodes), nodes[0]!)).toEqual({
      cancelBranch: false,
      retry: true,
    });
  });

  it("offers no retry for a skipped node whose dependency still blocks it", () => {
    const nodes = [node("a", "failed"), node("b", "skipped", ["a"])];
    expect(taskGraphNodeActions(graph("failed", nodes), nodes[1]!).retry).toBe(false);
  });

  it("retries a skipped node once its dependency has succeeded", () => {
    const nodes = [node("a", "succeeded"), node("b", "skipped", ["a"])];
    expect(taskGraphNodeActions(graph("failed", nodes), nodes[1]!).retry).toBe(true);
  });

  it("takes no edits on a cancelled graph", () => {
    const nodes = [node("a", "cancelled")];
    expect(taskGraphNodeActions(graph("cancelled", nodes), nodes[0]!)).toEqual({
      cancelBranch: false,
      retry: false,
    });
  });
});

describe("taskGraphNodeWaitDetail", () => {
  const now = new Date(2026, 9, 10, 9, 0).getTime();
  const waitUntil = new Date(2026, 9, 10, 15, 40).toISOString();
  const time = new Date(waitUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const waiting = (overrides: Partial<TaskGraphNode>) =>
    ({ status: "waiting", waitUntil, threadId: null, ...overrides }) as TaskGraphNode;

  it("says when a scheduled node starts", () => {
    expect(taskGraphNodeWaitDetail(waiting({ waitReason: "scheduled" }), now)).toBe(
      `Starts ${time}`,
    );
  });

  it("says whether a limited node starts or continues its thread after the reset", () => {
    expect(taskGraphNodeWaitDetail(waiting({ waitReason: "usage_limit" }), now)).toBe(
      `Usage limit reached — starts after the reset, ${time}`,
    );
    expect(
      taskGraphNodeWaitDetail(
        waiting({ waitReason: "usage_limit", threadId: "thread-a" as TaskGraphNode["threadId"] }),
        now,
      ),
    ).toBe(`Usage limit reached — continues on its thread after the reset, ${time}`);
  });

  it("names the day once the wait ends after today", () => {
    const tomorrow = waiting({ waitReason: "scheduled" });
    expect(taskGraphNodeWaitDetail(tomorrow, now - 86_400_000)).toBe(`Starts tomorrow at ${time}`);
    expect(taskGraphNodeWaitDetail({ ...tomorrow, status: "pending" }, now)).toBeNull();
  });
});
