import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type EnvironmentId,
  type LinearIssueDetail,
  type LinearSettings,
  type LinearWorkflowState,
  type ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftLinearIssue,
  buildLinearChatLaunchPlan,
  findLinearMappedProject,
  linearMoveHint,
  linearThreadUrl,
  linearWriteBackOf,
  resolveLinearChatLaunch,
  resolveLinearChatWorkspace,
} from "./launchPlan.ts";

const states: ReadonlyArray<LinearWorkflowState> = [
  { id: "todo", name: "Todo", type: "unstarted", color: "#999", position: 1 },
  { id: "prog", name: "In Progress", type: "started", color: "#f90", position: 2 },
];
const detail = (stateType: LinearWorkflowState["type"] = "unstarted") =>
  ({
    issue: {
      id: "issue-1",
      identifier: "ATT-612",
      branchName: "jan/att-612-rfid",
      team: { id: "team-1" },
      project: { id: "project-1" },
      state: { id: "s", name: "Todo", type: stateType, color: "#999" },
    },
  }) as never;
const settings = { moveToStateEnabled: true, moveToStateId: null, commentEnabled: false };

describe("buildDraftLinearIssue", () => {
  it("moves an unstarted issue to the team's first started state when enabled", () => {
    const draft = buildDraftLinearIssue({
      detail: detail(),
      settings,
      teamStates: states,
      mapping: { projectRef: "proj" as never },
    });
    expect(draft).toEqual({
      issueId: "issue-1",
      identifier: "ATT-612",
      teamId: "team-1",
      projectId: "project-1",
      branchName: "jan/att-612-rfid",
      mappedProjectId: "proj",
      moveTo: { id: "prog", name: "In Progress" },
      moveEnabled: true,
      commentEnabled: false,
    });
  });

  it("does not move an issue that is already started", () => {
    const draft = buildDraftLinearIssue({
      detail: detail("started"),
      settings,
      teamStates: states,
      mapping: null,
    });
    expect(draft).toMatchObject({ moveTo: null, moveEnabled: false, mappedProjectId: null });
  });

  it("keeps the move off when the settings switch it off or the states are unknown", () => {
    expect(
      buildDraftLinearIssue({
        detail: detail(),
        settings: { ...settings, moveToStateEnabled: false },
        teamStates: states,
        mapping: null,
      }),
    ).toMatchObject({ moveTo: { id: "prog" }, moveEnabled: false });
    expect(
      buildDraftLinearIssue({ detail: detail(), settings, teamStates: null, mapping: null }),
    ).toMatchObject({ moveTo: null, moveEnabled: false });
  });
});

describe("linearWriteBackOf", () => {
  it("asks for a move only when enabled", () => {
    expect(
      linearWriteBackOf({
        moveTo: { id: "prog", name: "In Progress" },
        moveEnabled: true,
        commentEnabled: true,
      }),
    ).toEqual({ moveToStateId: "prog", comment: true });
    expect(
      linearWriteBackOf({
        moveTo: { id: "prog", name: "In Progress" },
        moveEnabled: false,
        commentEnabled: false,
      }),
    ).toEqual({ comment: false });
  });
});

describe("resolveLinearChatWorkspace", () => {
  it("starts a worktree off the mapped base branch, or the checkout", () => {
    expect(resolveLinearChatWorkspace({ workspace: "worktree", baseBranch: "develop" })).toEqual({
      envMode: "worktree",
      branch: "develop",
      worktreePath: null,
    });
    expect(resolveLinearChatWorkspace({ workspace: "local", baseBranch: "develop" })).toEqual({
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
  });
});

describe("linearThreadUrl", () => {
  it("joins origin, environment and thread without doubling slashes", () => {
    expect(
      linearThreadUrl({
        origin: "https://app.example.com/",
        environmentId: "env-1" as EnvironmentId,
        threadId: "thr-1" as ThreadId,
      }),
    ).toBe("https://app.example.com/env-1/thr-1");
  });
});

describe("linearMoveHint", () => {
  it("names the target state, or nothing when no move applies", () => {
    expect(
      linearMoveHint({ identifier: "ATT-612", moveTo: { id: "p", name: "In Progress" } }),
    ).toBe("Moves ATT-612 to In Progress");
    expect(linearMoveHint({ identifier: "ATT-612", moveTo: null })).toBeNull();
  });
});

const env = "env-1" as EnvironmentId;
const mappedProject = ProjectId.make("proj-mapped");
const fullDetail = {
  issue: {
    id: "issue-1",
    identifier: "ATT-612",
    title: "Handshake",
    url: "https://linear.app/acme/issue/ATT-612",
    state: { id: "s", name: "Todo", type: "unstarted", color: "#999" },
    priority: 2,
    priorityLabel: "High",
    assignee: null,
    labels: [],
    cycle: null,
    milestone: null,
    project: null,
    team: { id: "team-1", key: "ATT", name: "Attraccess" },
    parent: null,
    subIssueCount: 0,
    completedSubIssueCount: 0,
    branchName: "jan/att-612",
    updatedAt: "2026-01-01T00:00:00.000Z",
    linkedPullRequests: [],
  },
  description: "Body",
  milestoneProgress: null,
  subIssues: [],
  subIssuesFailed: false,
  comments: [
    {
      id: "c1",
      author: null,
      body: "Use the traces.",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  attachments: [],
} as LinearIssueDetail;
const chatSettings: LinearSettings = {
  ...DEFAULT_SERVER_SETTINGS.linear,
  includeComments: false,
  commentEnabled: true,
  mappings: [
    {
      id: "m",
      kind: "team",
      linearId: "team-1",
      linearName: "Attraccess",
      projectId: mappedProject,
      baseBranch: "develop",
    },
  ],
};
const formatReference = (record: { readonly label: string }) => `@${record.label}`;

describe("findLinearMappedProject", () => {
  const projects = [
    { id: mappedProject, environmentId: "env-2" },
    { id: mappedProject, environmentId: env },
  ];

  it("finds the mapped project only in the given environment", () => {
    const mapping = { projectRef: mappedProject };
    expect(findLinearMappedProject({ environmentId: env, mapping, projects })).toBe(projects[1]);
    expect(findLinearMappedProject({ environmentId: "env-3", mapping, projects })).toBeUndefined();
  });

  it("finds nothing without a mapping", () => {
    expect(
      findLinearMappedProject({ environmentId: env, mapping: null, projects }),
    ).toBeUndefined();
  });
});

describe("buildLinearChatLaunchPlan", () => {
  it("attaches the issue per the settings, starts off the mapped base branch, and prompts", () => {
    const plan = buildLinearChatLaunchPlan({
      detail: fullDetail,
      settings: chatSettings,
      mapping: { projectRef: mappedProject, baseBranch: "develop", source: "team", mappingId: "m" },
      workspace: "worktree",
      teamStates: states,
      formatReference,
    });
    expect(plan.record).toMatchObject({ kind: "linear-issue", issueId: "issue-1", comments: [] });
    expect(plan.workspace).toEqual({ envMode: "worktree", branch: "develop", worktreePath: null });
    expect(plan.prompt).toBe(
      `@${plan.record.label}\n\nImplement ATT-612: Handshake.\n\nRead the attached issue, its sub-issues and comments first.\n\nWhen done, open a PR. Keep the branch name so Linear links it.`,
    );
    expect(plan.draftIssue).toMatchObject({
      issueId: "issue-1",
      mappedProjectId: mappedProject,
      moveTo: { id: "prog", name: "In Progress" },
      commentEnabled: true,
    });
  });
});

describe("resolveLinearChatLaunch", () => {
  const base = {
    environmentId: env,
    detail: fullDetail,
    settings: chatSettings,
    teamStates: states,
    projects: [{ id: mappedProject, environmentId: env }],
    workspace: undefined,
    formatReference,
  };

  it("starts in the mapped project, with the settings' default workspace", () => {
    const launch = resolveLinearChatLaunch({ ...base, chosenProjectId: undefined });
    expect(launch).toMatchObject({
      kind: "ready",
      projectId: mappedProject,
      plan: { workspace: { envMode: "worktree", branch: "develop" } },
    });
  });

  it("asks for a project when the mapped one is not in this environment", () => {
    expect(resolveLinearChatLaunch({ ...base, projects: [], chosenProjectId: undefined })).toEqual({
      kind: "needs-project",
    });
  });

  it("starts in a hand-picked project without the mapping's hint or base branch", () => {
    const picked = ProjectId.make("proj-picked");
    const launch = resolveLinearChatLaunch({ ...base, projects: [], chosenProjectId: picked });
    expect(launch).toMatchObject({
      kind: "ready",
      projectId: picked,
      plan: { workspace: { branch: null }, draftIssue: { mappedProjectId: null } },
    });
  });
});
