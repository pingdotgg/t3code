import type {
  EnvironmentId,
  LinearIssue,
  LinearIssueActivity,
  PipelineRunSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyRemoteRunStatus,
  mergeLinearActivity,
  remoteRunEnvironmentsKey,
  pickActivityPill,
  jumpBackInIssueIds,
  orderJumpBackInIssues,
  runningCountByTeam,
  stepTone,
  threadIdentifiersFromActivity,
} from "./activity.ts";

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
    items: [{ link: {}, pipeline: null } as LinearIssueActivity["items"][number]],
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

  it("picks the most recent issues for Jump back in, sorting ids so reorders keep the query", () => {
    const recent = [
      activity({ issueId: "old", latestActivityAt: "2026-01-01T00:00:00.000Z" }),
      activity({ issueId: "new", latestActivityAt: "2026-03-01T00:00:00.000Z" }),
      activity({ issueId: "mid", latestActivityAt: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(jumpBackInIssueIds(recent, 2)).toEqual(["mid", "new"]);
    const reordered = recent.map((entry) =>
      entry.issueId === "mid" ? { ...entry, latestActivityAt: "2026-04-01T00:00:00.000Z" } : entry,
    );
    expect(jumpBackInIssueIds(reordered, 2)).toEqual(["mid", "new"]);
    expect(
      orderJumpBackInIssues([issue("old"), issue("mid"), issue("new")], reordered).map(
        (entry) => entry.id,
      ),
    ).toEqual(["mid", "new", "old"]);
  });

  it("maps every linked thread, pipeline parents included, to its issue identifier", () => {
    const item = (threadId: string) =>
      ({ link: { threadId } }) as LinearIssueActivity["items"][number];
    const identifiers = threadIdentifiersFromActivity([
      activity({ issueIdentifier: "ATT-1", items: [item("t1"), item("t2")] }),
      activity({ issueId: "b", issueIdentifier: "ATT-2", items: [item("t3")] }),
    ]);
    expect([...identifiers]).toEqual([
      ["t1", "ATT-1"],
      ["t2", "ATT-1"],
      ["t3", "ATT-2"],
    ]);
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

describe("remote pipeline activity", () => {
  const envB = "env-b" as EnvironmentId;
  const entry = (
    issueId: string,
    targetId: string,
    environmentId: string | null,
    updatedAt = "2026-01-02T00:00:00.000Z",
  ): LinearIssueActivity =>
    ({
      issueId,
      issueIdentifier: issueId.toUpperCase(),
      teamId: "t",
      items: [
        {
          link: {
            linkId: `l-${targetId}`,
            issueId,
            targetKind: "pipeline_run",
            targetId,
            environmentId,
          },
          title: "Pipeline run",
          status: "idle",
          updatedAt,
          pipeline: null,
        },
      ],
      latestActivityAt: updatedAt,
      runningCount: 0,
      threadCount: 0,
      pipelineRunning: false,
      pipelineFailed: false,
    }) as unknown as LinearIssueActivity;

  it("stamps a peer's own items with its machine and drops duplicates", () => {
    const merged = mergeLinearActivity({
      primary: [entry("a", "run-1", null), entry("a", "run-2", "env-b")],
      peers: [
        { environmentId: envB, issues: [entry("a", "run-2", null), entry("b", "run-3", null)] },
      ],
    });
    expect(merged.map((issue) => issue.issueId).toSorted()).toEqual(["a", "b"]);
    const a = merged.find((issue) => issue.issueId === "a")!;
    expect(a.items.map((item) => [item.link.targetId, item.link.environmentId]).toSorted()).toEqual(
      [
        ["run-1", null],
        ["run-2", "env-b"],
      ],
    );
    expect(merged.find((issue) => issue.issueId === "b")?.items[0]?.link.environmentId).toBe(
      "env-b",
    );
  });

  it("shows a pipeline pill for a run on another machine and its live state when streamed", () => {
    const issues = [entry("a", "run-1", "env-b")];
    expect(pickActivityPill(issue("a"), issues[0])?.kind).toBe("pipeline-remote");

    const live = new Map([
      [
        "env-b:run-1",
        {
          id: "run-1",
          name: "Ship it",
          status: "paused",
          pauseReason: "step_failed",
          currentStepIndex: 0,
          steps: [{ stepId: "s", name: "Plan", status: "failed", childThreadId: null }],
        } as unknown as PipelineRunSummary,
      ],
    ]);
    const updated = applyRemoteRunStatus(issues, live);
    expect(updated[0]?.pipelineFailed).toBe(true);
    expect(pickActivityPill(issue("a"), updated[0])?.kind).toBe("pipeline-failed");
    expect(applyRemoteRunStatus(issues, new Map())).toBe(issues);
  });

  it("streams live runs only from connected machines holding unread runs", () => {
    const envC = "env-c" as EnvironmentId;
    const issues = [
      entry("a", "run-1", "env-c"),
      entry("b", "run-2", "env-b"),
      entry("c", "run-3", null),
      entry("d", "run-4", "env-d"),
    ];
    expect(remoteRunEnvironmentsKey(issues, [envC, envB])).toBe("env-b\nenv-c");
    expect(remoteRunEnvironmentsKey(issues, [])).toBe("");
  });
});
