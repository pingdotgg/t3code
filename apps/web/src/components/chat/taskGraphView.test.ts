import type { TaskGraphNode } from "@t3tools/contracts";
import { EnvironmentId, ProviderInstanceId, TaskGraphNodeKey, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { taskGraphLayers } from "@t3tools/shared/taskGraph";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestLabel,
  TASK_GRAPH_DIAGRAM,
  taskGraphDiagramLayout,
  taskGraphNodeKeyFromTitle,
  taskGraphNodeMachine,
  taskGraphNodeStatusText,
  taskGraphNodeWaitDetail,
  taskGraphProgressLabel,
  taskGraphPullRequestLinks,
  taskGraphResourcesLabel,
} from "./taskGraphView";

const isNodeKey = Schema.is(TaskGraphNodeKey);

const node = (key: string, overrides: Partial<TaskGraphNode> = {}): TaskGraphNode => ({
  key,
  title: key,
  prompt: "Do it",
  dependsOn: [],
  pullRequest: null,
  modelSelection: null,
  environmentId: null,
  workspace: "worktree",
  startAt: null,
  status: "pending",
  waitUntil: null,
  waitReason: null,
  assignedEnvironmentId: null,
  threadId: null,
  branch: null,
  worktreePath: null,
  summary: null,
  error: null,
  pullRequestResult: null,
  startedAt: null,
  completedAt: null,
  ...overrides,
});

describe("taskGraphNodeKeyFromTitle", () => {
  it("slugs a title into a valid key", () => {
    expect(taskGraphNodeKeyFromTitle("Audit the Auth flow!", [])).toBe("audit-the-auth-flow");
    expect(taskGraphNodeKeyFromTitle("  Ünïcode — café  ", [])).toBe("unicode-cafe");
  });

  it("falls back when the title has no usable characters", () => {
    expect(taskGraphNodeKeyFromTitle("!!!", [])).toBe("task");
    expect(taskGraphNodeKeyFromTitle("日本語", ["task"])).toBe("task-2");
  });

  it("adds a numeric suffix until the key is free", () => {
    expect(taskGraphNodeKeyFromTitle("Write tests", ["write-tests", "write-tests-2"])).toBe(
      "write-tests-3",
    );
  });

  it("keeps long keys within the length limit, suffix included", () => {
    const title = "a".repeat(30) + " " + "b".repeat(30);
    const first = taskGraphNodeKeyFromTitle(title, []);
    const second = taskGraphNodeKeyFromTitle(title, [first]);
    expect(first).toHaveLength(48);
    expect(second).toHaveLength(48);
    expect(second.endsWith("-2")).toBe(true);
    expect([first, second].every(isNodeKey)).toBe(true);
  });

  it("never ends the base in a dash after truncating", () => {
    const title = "a".repeat(46) + " bc";
    const key = taskGraphNodeKeyFromTitle(title, ["a".repeat(46) + "-b"]);
    expect(key).toBe("a".repeat(46) + "-2");
    expect(isNodeKey(key)).toBe(true);
  });
});

describe("pullRequestLabel", () => {
  it("reads the number from common hosts", () => {
    expect(pullRequestLabel("https://github.com/o/r/pull/42")).toBe("#42");
    expect(pullRequestLabel("https://gitlab.com/o/r/-/merge_requests/7")).toBe("#7");
    expect(pullRequestLabel("https://bitbucket.org/o/r/pull-requests/3/")).toBe("#3");
    expect(pullRequestLabel("https://example.com/review")).toBe("PR");
  });
});

describe("task graph summaries", () => {
  it("counts progress for a running graph", () => {
    const nodes = [
      node("a", { status: "succeeded" }),
      node("b", { status: "running" }),
      node("c", { status: "failed" }),
      node("d"),
      node("e", { status: "waiting", waitUntil: "2026-10-10T15:40:00.000Z" }),
    ];
    expect(taskGraphProgressLabel({ status: "running", nodes })).toBe(
      "1 of 5 done · 1 running · 1 waiting · 1 failed",
    );
    expect(taskGraphProgressLabel({ status: "draft", nodes: [node("a")] })).toBe("1 task");
  });

  it("names when a waiting node's wait ends and why", () => {
    const formatTime = (iso: string) => `<${iso.slice(11, 16)}>`;
    const waitUntil = "2026-10-10T15:40:00.000Z";
    const scheduled = node("a", { status: "waiting", waitReason: "scheduled", waitUntil });
    const limited = node("b", { status: "waiting", waitReason: "usage_limit", waitUntil });
    const stopped = { ...limited, threadId: ThreadId.make("thread-b") };

    expect(taskGraphNodeStatusText(scheduled, formatTime)).toBe("Waiting · until <15:40>");
    expect(taskGraphNodeStatusText(limited, formatTime)).toBe("Usage limit · resets <15:40>");
    expect(taskGraphNodeStatusText(node("c"), formatTime)).toBe("Pending");

    expect(taskGraphNodeWaitDetail(scheduled, formatTime)).toBe("Starts <15:40>");
    expect(taskGraphNodeWaitDetail(limited, formatTime)).toBe(
      "Usage limit reached — starts after the reset, <15:40>",
    );
    expect(taskGraphNodeWaitDetail(stopped, formatTime)).toBe(
      "Usage limit reached — continues on its thread after the reset, <15:40>",
    );
    expect(taskGraphNodeWaitDetail(node("c"), formatTime)).toBeNull();
  });

  it("lists only nodes with an opened pull request URL", () => {
    const links = taskGraphPullRequestLinks([
      node("a", {
        pullRequestResult: { status: "opened", url: "https://github.com/o/r/pull/9", error: null },
      }),
      node("b", { pullRequestResult: { status: "failed", url: null, error: "push rejected" } }),
      node("c"),
    ]);
    expect(links).toEqual([
      { key: "a", title: "a", url: "https://github.com/o/r/pull/9", label: "#9" },
    ]);
  });
});

describe("task graph models and machines", () => {
  const local = EnvironmentId.make("local");
  const buildBox = EnvironmentId.make("build-box");
  const opus = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
  const gpt = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };
  const mini = { instanceId: ProviderInstanceId.make("codex"), model: "mini" };
  const label = (selection: { readonly model: string }) => selection.model;

  it("places a node where it started, else after the worktree it continues, else where pinned", () => {
    const nodes = [
      node("a", { assignedEnvironmentId: buildBox, environmentId: local }),
      node("b", { workspace: "dependency", dependsOn: ["a"], environmentId: local }),
      node("c", { workspace: "dependency", dependsOn: ["b"] }),
      node("d", { environmentId: local }),
      node("e"),
    ];
    const machineOf = (key: string) =>
      taskGraphNodeMachine(
        nodes,
        nodes.find((entry) => entry.key === key)!,
      );
    expect(["a", "b", "c", "d", "e"].map(machineOf)).toEqual([
      buildBox,
      buildBox,
      buildBox,
      local,
      null,
    ]);
  });

  it("names distinct models, the graph's default included, and counts machines", () => {
    const graph = {
      modelSelection: opus,
      nodes: [
        node("a", { environmentId: local }),
        node("b", { modelSelection: gpt, assignedEnvironmentId: buildBox }),
        node("c", { modelSelection: opus }),
      ],
    };
    expect(taskGraphResourcesLabel(graph, label)).toBe("opus · gpt · 2 machines");
    expect(
      taskGraphResourcesLabel(
        { ...graph, nodes: [...graph.nodes, node("d", { modelSelection: mini })] },
        label,
      ),
    ).toBe("opus · gpt +1 · 2 machines");
  });

  it("calls a graph with nothing pinned or started auto-balanced", () => {
    expect(taskGraphResourcesLabel({ modelSelection: null, nodes: [node("a")] }, label)).toBe(
      "auto-balanced",
    );
    expect(
      taskGraphResourcesLabel(
        { modelSelection: gpt, nodes: [node("a", { environmentId: local })] },
        label,
      ),
    ).toBe("gpt · 1 machine");
  });
});

describe("taskGraphDiagramLayout", () => {
  const { nodeWidth, nodeHeight, columnGap, rowGap } = TASK_GRAPH_DIAGRAM;

  it("lays a fan-out and merge left to right with one edge per dependency", () => {
    // audit -> (fix-a, fix-b) -> review, the shape of the security audit example.
    const layout = taskGraphDiagramLayout(
      taskGraphLayers([
        node("audit"),
        node("fix-a", { dependsOn: ["audit"] }),
        node("fix-b", { dependsOn: ["audit"] }),
        node("review", { dependsOn: ["fix-a", "fix-b"] }),
      ]),
    );
    const at = (key: string) => layout.nodes.find((entry) => entry.node.key === key)!;

    expect(layout.width).toBe(3 * nodeWidth + 2 * columnGap);
    expect(layout.height).toBe(2 * nodeHeight + rowGap);
    expect([at("audit").x, at("fix-a").x, at("review").x]).toEqual([
      0,
      nodeWidth + columnGap,
      2 * (nodeWidth + columnGap),
    ]);
    // Single-node columns sit centred against the two-node column.
    expect(at("audit").y).toBe((nodeHeight + rowGap) / 2);
    expect(at("review").y).toBe(at("audit").y);
    expect(layout.edges.map((edge) => edge.key)).toEqual([
      "audit->fix-a",
      "audit->fix-b",
      "fix-a->review",
      "fix-b->review",
    ]);
    expect(layout.edges[0]!.path.startsWith(`M ${nodeWidth} `)).toBe(true);
  });

  it("is empty for an empty graph", () => {
    expect(taskGraphDiagramLayout([])).toEqual({ width: 0, height: 0, nodes: [], edges: [] });
  });
});
