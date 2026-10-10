import type { TaskGraphNode } from "@t3tools/contracts";
import { TaskGraphNodeKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestLabel,
  taskGraphNodeKeyFromTitle,
  taskGraphProgressLabel,
  taskGraphPullRequestLinks,
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
  status: "pending",
  assignedEnvironmentId: null,
  threadId: null,
  branch: null,
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
    ];
    expect(taskGraphProgressLabel({ status: "running", nodes })).toBe(
      "1 of 4 done · 1 running · 1 failed",
    );
    expect(taskGraphProgressLabel({ status: "draft", nodes: [node("a")] })).toBe("1 task");
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
