import type { LinearIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupLinearIssues, linearBadgeTextTone, topLevelIssues } from "./issueList.ts";

function issue(
  id: string,
  overrides: Partial<
    Pick<LinearIssue, "state" | "milestone" | "parent" | "linkedPullRequests">
  > = {},
): LinearIssue {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    url: "",
    state: { id: "s-todo", name: "Todo", type: "unstarted", color: "#fff" },
    priority: 0,
    priorityLabel: "No priority",
    assignee: null,
    labels: [],
    cycle: null,
    milestone: null,
    project: null,
    team: { id: "t", key: "ATT", name: "Attraccess" },
    parent: null,
    subIssueCount: 0,
    completedSubIssueCount: 0,
    branchName: id,
    updatedAt: "2026-01-01T00:00:00.000Z",
    linkedPullRequests: [],
    ...overrides,
  } as LinearIssue;
}

describe("topLevelIssues", () => {
  it("nests sub-issues whose parent is listed", () => {
    const list = [
      issue("p"),
      issue("c", { parent: { id: "p", identifier: "P" } }),
      issue("orphan", { parent: { id: "elsewhere", identifier: "X" } }),
    ];
    expect(topLevelIssues(list).map((entry) => entry.id)).toEqual(["p", "orphan"]);
  });
});

describe("groupLinearIssues", () => {
  const review = { id: "s-review", name: "In Review", type: "started", color: "#0f0" } as const;
  const progress = {
    id: "s-progress",
    name: "In Progress",
    type: "started",
    color: "#ff0",
  } as const;
  const todo = { id: "s-todo", name: "Todo", type: "unstarted", color: "#fff" } as const;
  const done = { id: "s-done", name: "Done", type: "completed", color: "#00f" } as const;

  it("groups by state in workflow order, later started steps first", () => {
    const groups = groupLinearIssues(
      [
        issue("a", { state: todo }),
        issue("b", { state: done }),
        issue("c", { state: progress }),
        issue("d", { state: review }),
      ],
      "state",
      new Map([
        ["s-progress", 2],
        ["s-review", 3],
        ["s-todo", 1],
        ["s-done", 4],
      ]),
    );
    expect(groups.map((group) => group.label)).toEqual([
      "In Review",
      "In Progress",
      "Todo",
      "Done",
    ]);
  });

  it("groups by milestone with the unassigned bucket last", () => {
    const groups = groupLinearIssues(
      [issue("a"), issue("b", { milestone: { id: "m", name: "v1" } })],
      "milestone",
    );
    expect(groups.map((group) => group.label)).toEqual(["v1", "No milestone"]);
  });

  it("returns one flat group for none and nothing for no issues", () => {
    expect(groupLinearIssues([issue("a"), issue("b")], "none")).toHaveLength(1);
    expect(groupLinearIssues([], "none")).toEqual([]);
  });
});

describe("linearBadgeTextTone", () => {
  it("picks dark text on light team colors and light text on dark ones", () => {
    expect(linearBadgeTextTone("#f2c94c")).toBe("dark");
    expect(linearBadgeTextTone("#fff")).toBe("dark");
    expect(linearBadgeTextTone("#5e6ad2")).toBe("light");
    expect(linearBadgeTextTone("#000000ff")).toBe("light");
    expect(linearBadgeTextTone("#12345")).toBe("light");
  });
});
