import type { TaskGraph, TaskGraphNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveTaskGraphSegment,
  sortTaskGraphs,
  taskGraphActions,
  taskGraphNodeActions,
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
