import type { EnvironmentId, LinearWorkflowState, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftLinearIssue,
  linearMoveHint,
  linearThreadUrl,
  linearWriteBackOf,
  resolveLinearChatWorkspace,
} from "./linearLaunch.logic";

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
