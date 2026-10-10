import type { TaskGraphNode, TaskGraphNodeInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyTaskGraphEdits,
  buildTaskGraphNodePrompt,
  deriveTaskGraphStatus,
  newTaskGraphNode,
  readyTaskGraphNodes,
  resumeTaskGraphNode,
  skipUnreachableTaskGraphNodes,
  taskGraphLayers,
  taskGraphNodeOpensPullRequest,
  taskGraphPullRequestBase,
  validateTaskGraphNodes,
} from "./taskGraph.ts";

const NOW = "2026-10-10T00:00:00.000Z";

const input = (key: string, dependsOn: ReadonlyArray<string> = []): TaskGraphNodeInput =>
  ({ key, title: key, prompt: `do ${key}`, dependsOn }) as TaskGraphNodeInput;

const graph = (...inputs: ReadonlyArray<TaskGraphNodeInput>) => inputs.map(newTaskGraphNode);

const withStatus = (
  nodes: ReadonlyArray<TaskGraphNode>,
  statuses: Record<string, TaskGraphNode["status"]>,
) => nodes.map((node) => ({ ...node, status: statuses[node.key] ?? node.status }));

// a -> (b, c) -> d: the fan-out and merge shape from the security audit example.
const diamond = () =>
  graph(input("a"), input("b", ["a"]), input("c", ["a"]), input("d", ["b", "c"]));

describe("validateTaskGraphNodes", () => {
  it("accepts a diamond", () => {
    expect(validateTaskGraphNodes(diamond())).toBeNull();
  });

  it("rejects cycles, unknown dependencies and duplicate keys", () => {
    expect(validateTaskGraphNodes(graph(input("a", ["b"]), input("b", ["a"])))).toMatch(/cycle/);
    expect(validateTaskGraphNodes(graph(input("a", ["missing"])))).toMatch(/not in the graph/);
    expect(validateTaskGraphNodes(graph(input("a"), input("a")))).toMatch(/used twice/);
  });
});

describe("scheduling", () => {
  it("releases a node only once every dependency succeeded", () => {
    const nodes = diamond();
    expect(readyTaskGraphNodes(nodes, NOW).map((node) => node.key)).toEqual(["a"]);
    const afterB = withStatus(nodes, { a: "succeeded", b: "succeeded", c: "running" });
    expect(readyTaskGraphNodes(afterB, NOW)).toEqual([]);
    const afterC = withStatus(afterB, { c: "succeeded" });
    expect(readyTaskGraphNodes(afterC, NOW).map((node) => node.key)).toEqual(["d"]);
  });

  it("skips everything below a failed node", () => {
    const nodes = withStatus(diamond(), { a: "failed" });
    const skipped = skipUnreachableTaskGraphNodes(nodes, NOW);
    expect(skipped.map((node) => node.status)).toEqual(["failed", "skipped", "skipped", "skipped"]);
    expect(deriveTaskGraphStatus("running", skipped)).toBe("failed");
  });

  it("keeps a draft a draft and derives the end state", () => {
    expect(deriveTaskGraphStatus("draft", diamond())).toBe("draft");
    expect(deriveTaskGraphStatus("running", diamond())).toBe("running");
    const done = withStatus(diamond(), {
      a: "succeeded",
      b: "succeeded",
      c: "succeeded",
      d: "succeeded",
    });
    expect(deriveTaskGraphStatus("running", done)).toBe("succeeded");
  });

  it("keeps a cancelled graph cancelled even when a node failed", () => {
    const ended = withStatus(diamond(), {
      a: "succeeded",
      b: "failed",
      c: "cancelled",
      d: "cancelled",
    });
    expect(deriveTaskGraphStatus("running", ended)).toBe("failed");
    expect(deriveTaskGraphStatus("cancelled", ended)).toBe("cancelled");
  });

  it("opens pull requests from the ends of the tree by default", () => {
    const nodes = diamond();
    expect(nodes.map((node) => taskGraphNodeOpensPullRequest(nodes, node))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("lays nodes out by depth", () => {
    expect(taskGraphLayers(diamond()).map((layer) => layer.map((node) => node.key))).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
    ]);
  });
});

describe("applyTaskGraphEdits", () => {
  it("cancels a branch and everything under it, leaving finished work alone", () => {
    const nodes = withStatus(diamond(), { a: "succeeded", b: "running" });
    const result = applyTaskGraphEdits(nodes, [{ type: "cancel_branch", key: "b" }], NOW);
    expect(result.ok && result.nodes.map((node) => node.status)).toEqual([
      "succeeded",
      "cancelled",
      "pending",
      "cancelled",
    ]);
  });

  it("retries a node and reopens what was skipped below it", () => {
    const nodes = skipUnreachableTaskGraphNodes(withStatus(diamond(), { a: "failed" }), NOW);
    const result = applyTaskGraphEdits(nodes, [{ type: "retry_node", key: "a" }], NOW);
    expect(result.ok && result.nodes.every((node) => node.status === "pending")).toBe(true);
  });

  it("removes a pending node and its edges", () => {
    const result = applyTaskGraphEdits(diamond(), [{ type: "remove_node", key: "c" }], NOW);
    expect(result.ok && result.nodes.find((node) => node.key === "d")?.dependsOn).toEqual(["b"]);
  });

  it("refuses to edit a started node and applies nothing from a failing batch", () => {
    const nodes = withStatus(diamond(), { a: "running" });
    const result = applyTaskGraphEdits(
      nodes,
      [
        { type: "add_node", node: input("e", ["d"]) },
        { type: "update_node", key: "a", prompt: "changed" },
      ],
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an edit that would create a cycle", () => {
    const result = applyTaskGraphEdits(
      diamond(),
      [{ type: "update_node", key: "a", dependsOn: ["d"] }],
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/cycle/) });
  });
});

describe("buildTaskGraphNodePrompt", () => {
  it("hands a merge node its dependencies' results and branches to merge", () => {
    const nodes = diamond().map((node) =>
      node.key === "b" || node.key === "c"
        ? {
            ...node,
            status: "succeeded" as const,
            branch: `t3/${node.key}`,
            summary: `${node.key} done`,
          }
        : node,
    );
    const prompt = buildTaskGraphNodePrompt({ title: "Audit", nodes }, nodes[3]!);
    expect(prompt).toContain("- t3/c (from 'c')");
    expect(prompt).not.toContain("- t3/b");
    expect(prompt).toContain("b done");
    expect(prompt).toContain("do d");
  });

  it("never asks a project-folder node to merge branches", () => {
    const nodes = diamond().map((node) =>
      node.key === "b" || node.key === "c"
        ? { ...node, status: "succeeded" as const, branch: `t3/${node.key}` }
        : node.key === "d"
          ? { ...node, workspace: "root" as const }
          : node,
    );
    const prompt = buildTaskGraphNodePrompt({ title: "Audit", nodes }, nodes[3]!);
    expect(prompt).not.toContain("git merge");
    expect(prompt).toContain("read-only");
  });
});

describe("resumeTaskGraphNode", () => {
  it("runs a failed node again on its thread and reopens what was skipped below it", () => {
    const failed = skipUnreachableTaskGraphNodes(
      withStatus(diamond(), { a: "succeeded", b: "failed", c: "succeeded" }).map((node) =>
        node.key === "b" ? { ...node, threadId: "thread-b" as never, error: "boom" } : node,
      ),
      NOW,
    );
    expect(failed.find((node) => node.key === "d")?.status).toBe("skipped");

    const resumed = resumeTaskGraphNode(failed, "b")!;
    const b = resumed.find((node) => node.key === "b")!;
    expect([b.status, b.threadId, b.error]).toEqual(["running", "thread-b", null]);
    expect(resumed.find((node) => node.key === "d")?.status).toBe("pending");
  });

  it("leaves nodes that did not fail alone", () => {
    expect(resumeTaskGraphNode(withStatus(diamond(), { a: "succeeded" }), "a")).toBeNull();
  });
});

describe("workspaces and pull request bases", () => {
  // a -> b -> c, each on its own branch once it has run.
  const chain = (overrides: Record<string, Partial<TaskGraphNode>> = {}) =>
    graph(input("a"), input("b", ["a"]), input("c", ["b"])).map((node) => ({
      ...node,
      branch: `t3/${node.key}`,
      ...overrides[node.key],
    }));

  it("points a lone branch-end PR at the graph base so it carries all the work", () => {
    const nodes = chain();
    expect(taskGraphPullRequestBase({ nodes, baseRef: "main" }, nodes[2]!)).toBe("main");
  });

  it("stacks PRs when inner nodes open their own", () => {
    const nodes = chain({ a: { pullRequest: true }, b: { pullRequest: true } });
    const base = (key: string) =>
      taskGraphPullRequestBase(
        { nodes, baseRef: "main" },
        nodes.find((node) => node.key === key)!,
      );
    expect([base("a"), base("b"), base("c")]).toEqual(["main", "t3/a", "t3/b"]);
  });

  it("skips the nodes sharing a branch when finding the layer below", () => {
    const nodes = chain({
      a: { pullRequest: true },
      c: { workspace: "dependency", branch: "t3/b" },
    });
    expect(taskGraphPullRequestBase({ nodes, baseRef: "main" }, nodes[2]!)).toBe("t3/a");
  });

  it("never opens a PR from the project folder", () => {
    const nodes = graph({ ...input("review"), workspace: "root", pullRequest: true });
    expect(taskGraphNodeOpensPullRequest(nodes, nodes[0]!)).toBe(false);
  });

  it("checks that a continued worktree exists and is continued only once", () => {
    expect(validateTaskGraphNodes(graph({ ...input("a"), workspace: "dependency" }))).toMatch(
      /depends on nothing/,
    );
    expect(
      validateTaskGraphNodes(
        graph(
          input("a"),
          { ...input("b", ["a"]), workspace: "dependency" },
          { ...input("c", ["a"]), workspace: "dependency" },
        ),
      ),
    ).toMatch(/Only one node/);
  });
});

describe("waiting nodes", () => {
  it("holds a node that has not started until its wait ends", () => {
    const later = "2026-10-10T06:00:00.000Z";
    const nodes = graph(input("a")).map((node) => ({
      ...node,
      status: "waiting" as const,
      waitUntil: later,
      waitReason: "scheduled" as const,
    }));
    expect(readyTaskGraphNodes(nodes, NOW)).toEqual([]);
    expect(readyTaskGraphNodes(nodes, later).map((node) => node.key)).toEqual(["a"]);
  });

  it("lets a waiting node be edited, and starts the wait over", () => {
    const nodes = graph(input("a")).map((node) => ({
      ...node,
      status: "waiting" as const,
      waitUntil: NOW,
      waitReason: "usage_limit" as const,
    }));
    const result = applyTaskGraphEdits(
      nodes,
      [{ type: "update_node", key: "a", startAt: "2026-10-11T00:00:00.000Z" }],
      NOW,
    );
    expect(result.ok && result.nodes[0]).toMatchObject({
      status: "pending",
      waitUntil: null,
      startAt: "2026-10-11T00:00:00.000Z",
    });
  });
});
