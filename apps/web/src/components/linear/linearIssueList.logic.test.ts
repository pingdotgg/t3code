import type { LinearIssue, LinearIssueActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupLinearIssues,
  pickActivityPill,
  recentActivityIssueIds,
  runningCountByTeam,
  stepTone,
  topLevelIssues,
} from "./linearIssueList.logic";

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

function activity(overrides: Partial<LinearIssueActivity> = {}): LinearIssueActivity {
  return {
    issueId: "a",
    issueIdentifier: "ATT-1",
    teamId: "t",
    items: [{} as LinearIssueActivity["items"][number]],
    latestActivityAt: "2026-01-02T00:00:00.000Z",
    runningCount: 0,
    threadCount: 0,
    pipelineRunning: false,
    pipelineFailed: false,
    ...overrides,
  };
}

const OPEN_PR = { repository: "o/r", number: 1, state: "OPEN", url: "u" };

describe("pickActivityPill", () => {
  it("shows nothing without T3 links", () => {
    expect(pickActivityPill(issue("a"), undefined)).toBeNull();
    expect(pickActivityPill(issue("a"), activity({ items: [] }))).toBeNull();
  });

  it("ranks pipeline failed over running over PR opened over chats", () => {
    const withPr = issue("a", { linkedPullRequests: [OPEN_PR] });
    const all = { pipelineFailed: true, pipelineRunning: true, threadCount: 2 };
    expect(pickActivityPill(withPr, activity(all))?.kind).toBe("pipeline-failed");
    expect(pickActivityPill(withPr, activity({ ...all, pipelineFailed: false }))?.kind).toBe(
      "pipeline-running",
    );
    expect(
      pickActivityPill(withPr, activity({ ...all, pipelineFailed: false, pipelineRunning: false }))
        ?.kind,
    ).toBe("pr-opened");
    expect(pickActivityPill(issue("a"), activity({ threadCount: 2 }))).toEqual({
      kind: "chats",
      label: "2 chats",
      chatCount: 0,
    });
  });

  it("does not count a merged PR as opened and singularizes one chat", () => {
    const merged = issue("a", { linkedPullRequests: [{ ...OPEN_PR, state: "MERGED" }] });
    expect(pickActivityPill(merged, activity({ threadCount: 1 }))?.label).toBe("1 chat");
  });

  it("carries the chat count beside pipeline and PR pills", () => {
    expect(
      pickActivityPill(issue("a"), activity({ pipelineFailed: true, threadCount: 1 })),
    ).toEqual({ kind: "pipeline-failed", label: "pipeline failed", chatCount: 1 });
  });

  it("has no pill for links that are only idle pipeline items", () => {
    expect(pickActivityPill(issue("a"), activity())).toBeNull();
  });
});

describe("activity summaries", () => {
  it("counts running items per team", () => {
    const counts = runningCountByTeam([
      activity({ teamId: "t1", runningCount: 2 }),
      activity({ issueId: "b", teamId: "t1", runningCount: 1 }),
      activity({ issueId: "c", teamId: "t2", runningCount: 0 }),
    ]);
    expect(counts.get("t1")).toBe(3);
    expect(counts.has("t2")).toBe(false);
  });

  it("orders recent activity newest first and caps", () => {
    expect(
      recentActivityIssueIds(
        [
          activity({ issueId: "old", latestActivityAt: "2026-01-01T00:00:00.000Z" }),
          activity({ issueId: "new", latestActivityAt: "2026-03-01T00:00:00.000Z" }),
          activity({ issueId: "mid", latestActivityAt: "2026-02-01T00:00:00.000Z" }),
        ],
        2,
      ),
    ).toEqual(["new", "mid"]);
  });

  it("maps step statuses to tones", () => {
    expect(["completed", "running", "failed", "pending", "skipped"].map(stepTone)).toEqual([
      "ok",
      "running",
      "failed",
      "idle",
      "idle",
    ]);
  });
});

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
