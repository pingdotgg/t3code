import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  type EnvironmentId,
  type LinearIssueDetail,
  type LinearWorkflowState,
  type ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  includesFromSettings,
  pipelineInputSummary,
  pipelineInputText,
  pipelineLaunchRecord,
  pipelineWorkspaceStrategy,
  readLastUsedPipelineName,
  resolvePipelineLaunch,
  writeLastUsedPipelineName,
} from "./pipelineDialog.ts";

const detail = {
  issue: {
    id: "i",
    identifier: "ATT-612",
    title: "Handshake",
    url: "https://linear.app/x",
    state: { id: "s", name: "Todo", type: "unstarted", color: "#999" },
    priorityLabel: "High",
    assignee: null,
    labels: [],
    milestone: null,
    project: null,
    team: { id: "t", key: "ATT", name: "Attraccess" },
    branchName: "jan/att-612",
    linkedPullRequests: [],
  },
  description: "Body",
  milestoneProgress: null,
  subIssues: [],
  comments: [],
  attachments: [],
} as unknown as LinearIssueDetail;

describe("last used pipeline storage", () => {
  it("round-trips and survives broken storage", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
    expect(readLastUsedPipelineName(storage)).toBeNull();
    writeLastUsedPipelineName(storage, "p1");
    expect(readLastUsedPipelineName(storage)).toBe("p1");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLastUsedPipelineName(broken)).toBeNull();
    expect(() => writeLastUsedPipelineName(broken, "p1")).not.toThrow();
    expect(readLastUsedPipelineName(undefined)).toBeNull();
  });
});

describe("pipelineInputText", () => {
  const includes = includesFromSettings({
    includeSubIssues: true,
    includeComments: true,
    includeLinkedPrs: false,
  });
  it("renders the issue unless the person edited the text", () => {
    expect(pipelineInputText({ detail, includes, edited: null })).toContain(
      "# ATT-612 · Handshake",
    );
    expect(pipelineInputText({ detail, includes, edited: "my words" })).toBe("my words");
  });
  it("keeps an emptied edit rather than regenerating", () => {
    expect(pipelineInputText({ detail, includes, edited: "" })).toBe("");
  });
});

describe("pipelineInputSummary", () => {
  it("counts includable items and estimates tokens from the text", () => {
    expect(pipelineInputSummary({ detail, text: "x".repeat(7_600) })).toEqual({
      counts: { subIssues: 0, comments: 0, linkedPrs: 0 },
      tokens: "~1.9k tokens",
      overLimit: false,
      startable: true,
      sizeLabel: "~1.9k tokens",
    });
  });

  it("refuses blank input and input over the provider limit", () => {
    expect(pipelineInputSummary({ detail, text: "  \n" }).startable).toBe(false);
    const over = pipelineInputSummary({
      detail,
      text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1),
    });
    expect(over).toMatchObject({ overLimit: true, startable: false });
    expect(over.sizeLabel).toBe(
      `${over.tokens} · over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} character limit`,
    );
    expect(
      pipelineInputSummary({ detail, text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS) })
        .startable,
    ).toBe(true);
  });
});

describe("resolvePipelineLaunch", () => {
  const mapped = ProjectId.make("proj-mapped");
  const other = ProjectId.make("proj-other");
  const teamStates: ReadonlyArray<LinearWorkflowState> = [
    { id: "prog", name: "In Progress", type: "started", color: "#f90", position: 1 },
  ];
  const settings = {
    mappings: [
      {
        id: "m",
        kind: "team" as const,
        linearId: "t",
        linearName: "Attraccess",
        projectId: mapped,
        baseBranch: "develop",
      },
    ],
    moveToStateId: null,
    moveToStateEnabled: true,
    commentEnabled: false,
  };
  const noChoices = { projectId: null, move: null, comment: null };

  it("defaults to the mapped project, its base branch, and the settings' write-backs", () => {
    expect(
      resolvePipelineLaunch({
        issue: detail.issue,
        settings,
        teamStates,
        projectIds: [mapped, other],
        choices: noChoices,
      }),
    ).toEqual({
      mappedProjectId: mapped,
      projectId: mapped,
      mappedBaseBranch: "develop",
      moveTarget: { id: "prog", name: "In Progress" },
      moveEnabled: true,
      commentEnabled: false,
    });
  });

  it("lets choices win, dropping the mapped base branch for another project", () => {
    expect(
      resolvePipelineLaunch({
        issue: detail.issue,
        settings,
        teamStates,
        projectIds: [mapped, other],
        choices: { projectId: other, move: false, comment: true },
      }),
    ).toMatchObject({
      mappedProjectId: mapped,
      projectId: other,
      mappedBaseBranch: null,
      moveEnabled: false,
      commentEnabled: true,
    });
  });

  it("has no mapped project outside this environment and no move without team states", () => {
    expect(
      resolvePipelineLaunch({
        issue: detail.issue,
        settings,
        teamStates: null,
        projectIds: [other],
        choices: noChoices,
      }),
    ).toMatchObject({
      mappedProjectId: null,
      projectId: null,
      mappedBaseBranch: null,
      moveTarget: null,
      moveEnabled: false,
    });
  });
});

describe("pipelineLaunchRecord", () => {
  it("links the run's parent thread under the pipeline and issue name", () => {
    expect(
      pipelineLaunchRecord({
        environmentId: "env-1" as EnvironmentId,
        issue: detail.issue,
        pipelineName: "Ship it",
        run: { id: "run-1", parentThreadId: "thr-1" as ThreadId },
        writeBack: {
          moveTo: { id: "prog", name: "In Progress" },
          moveEnabled: true,
          commentEnabled: false,
        },
      }),
    ).toEqual({
      environmentId: "env-1",
      issueId: "i",
      identifier: "ATT-612",
      teamId: "t",
      projectId: undefined,
      target: {
        kind: "pipeline_run",
        targetId: "run-1",
        threadId: "thr-1",
        title: "Ship it: ATT-612 Handshake",
      },
      writeBack: { moveToStateId: "prog", comment: false },
    });
  });
});

describe("pipelineLaunchRecord routing", () => {
  const base = {
    environmentId: "env-b" as EnvironmentId,
    issue: detail.issue,
    pipelineName: "Ship it",
    run: { id: "run-1", parentThreadId: "thr-1" as ThreadId },
    writeBack: { moveTo: null, moveEnabled: false, commentEnabled: true },
  };

  it("records on the run's machine for a seamless route", () => {
    const record = pipelineLaunchRecord({
      ...base,
      route: { kind: "seamless", recordOn: "env-b" as EnvironmentId },
    });
    expect(record.recordOn).toBe("env-b");
    expect(record.remote).toBeUndefined();
  });

  it("records on the primary and remembers the machine for a fallback route", () => {
    const record = pipelineLaunchRecord({
      ...base,
      route: { kind: "fallback", recordOn: "env-a" as EnvironmentId, machineName: "Studio" },
    });
    expect(record.environmentId).toBe("env-b");
    expect(record.recordOn).toBe("env-a");
    expect(record.remote).toEqual({ machineName: "Studio", pipelineName: "Ship it" });
  });
});

describe("pipelineWorkspaceStrategy", () => {
  it("uses a worktree on the branch name off the base ref", () => {
    expect(
      pipelineWorkspaceStrategy({
        workspace: "worktree",
        baseRef: "develop",
        branchName: "jan/att-612",
      }),
    ).toEqual({ type: "worktree", baseRef: "develop", branch: "jan/att-612" });
  });
  it("falls back to HEAD without a base and omits an empty branch name", () => {
    expect(
      pipelineWorkspaceStrategy({ workspace: "worktree", baseRef: null, branchName: "" }),
    ).toEqual({
      type: "worktree",
      baseRef: "HEAD",
    });
  });
  it("runs in the checkout for local", () => {
    expect(
      pipelineWorkspaceStrategy({ workspace: "local", baseRef: "x", branchName: "y" }),
    ).toEqual({
      type: "root",
    });
  });
});
