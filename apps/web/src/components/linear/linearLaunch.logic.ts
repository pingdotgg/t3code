import type {
  EnvironmentId,
  LinearIssueDetail,
  LinearRecordLaunchInput,
  LinearSettings,
  LinearWorkflowState,
  ThreadId,
} from "@t3tools/contracts";
import {
  resolveLinearMoveTarget,
  type LinearMappingResolution,
} from "@t3tools/shared/linearLaunch";

import type { DraftLinearIssue } from "../../composerDraftStore";
import type { LinearLaunchWorkspace } from "./linearLaunchTypes";

type LaunchSettings = Pick<
  LinearSettings,
  "moveToStateEnabled" | "moveToStateId" | "commentEnabled"
>;

/**
 * What a draft started from an issue carries until it is sent: the issue, its branch name, and the
 * write-backs this launch will do. Move needs the team's states; without them it stays off.
 */
export function buildDraftLinearIssue(input: {
  readonly detail: Pick<LinearIssueDetail, "issue">;
  readonly settings: LaunchSettings;
  readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
  readonly mapping: Pick<LinearMappingResolution, "projectRef"> | null;
}): DraftLinearIssue {
  const { issue } = input.detail;
  const moveTarget =
    input.teamStates === null
      ? null
      : resolveLinearMoveTarget({
          currentStateType: issue.state.type,
          teamStates: input.teamStates,
          preferredStateId: input.settings.moveToStateId,
        });
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    branchName: issue.branchName,
    mappedProjectId: input.mapping?.projectRef ?? null,
    moveTo: moveTarget,
    moveEnabled: input.settings.moveToStateEnabled && moveTarget !== null,
    commentEnabled: input.settings.commentEnabled,
  };
}

/** The write-back the server is asked to perform for one launch. */
export function linearWriteBackOf(
  launch: Pick<DraftLinearIssue, "moveTo" | "moveEnabled" | "commentEnabled">,
): LinearRecordLaunchInput["writeBack"] {
  return {
    ...(launch.moveEnabled && launch.moveTo ? { moveToStateId: launch.moveTo.id } : {}),
    comment: launch.commentEnabled,
  };
}

/** Where a chat from an issue starts: a new worktree off the base branch, or the checkout. */
export function resolveLinearChatWorkspace(input: {
  readonly workspace: LinearLaunchWorkspace;
  readonly baseBranch: string | null;
}) {
  return input.workspace === "worktree"
    ? ({ envMode: "worktree", branch: input.baseBranch, worktreePath: null } as const)
    : ({ envMode: "local", branch: null, worktreePath: null } as const);
}

export function linearThreadUrl(input: {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `${input.origin.replace(/\/+$/u, "")}/${input.environmentId}/${input.threadId}`;
}

export function linearMoveHint(launch: Pick<DraftLinearIssue, "identifier" | "moveTo">) {
  return launch.moveTo ? `Moves ${launch.identifier} to ${launch.moveTo.name}` : null;
}
