import type {
  EnvironmentId,
  LinearIssueDetail,
  LinearRecordLaunchInput,
  LinearSettings,
  LinearWorkflowState,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildLinearIssueContextRecord,
  buildLinearIssuePrompt,
  resolveLinearMoveTarget,
  type LinearMappingResolution,
} from "@t3tools/shared/linearLaunch";

export type LinearLaunchWorkspace = "worktree" | "local";

/** What a draft started from an issue carries until it is sent. */
export interface LinearDraftIssue {
  readonly issueId: string;
  readonly identifier: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly branchName: string;
  readonly mappedProjectId: string | null;
  readonly moveTo: { readonly id: string; readonly name: string } | null;
  readonly moveEnabled: boolean;
  readonly commentEnabled: boolean;
}

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
}): LinearDraftIssue {
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
    teamId: issue.team.id,
    ...(issue.project ? { projectId: issue.project.id } : {}),
    branchName: issue.branchName,
    mappedProjectId: input.mapping?.projectRef ?? null,
    moveTo: moveTarget,
    moveEnabled: input.settings.moveToStateEnabled && moveTarget !== null,
    commentEnabled: input.settings.commentEnabled,
  };
}

/** The write-back the server is asked to perform for one launch. */
export function linearWriteBackOf(
  launch: Pick<LinearDraftIssue, "moveTo" | "moveEnabled" | "commentEnabled">,
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

export function linearMoveHint(launch: Pick<LinearDraftIssue, "identifier" | "moveTo">) {
  return launch.moveTo ? `Moves ${launch.identifier} to ${launch.moveTo.name}` : null;
}

/** The T3 project a mapping points at, when it exists in the given environment. */
export function findLinearMappedProject<
  P extends { readonly id: string; readonly environmentId: string },
>(input: {
  readonly environmentId: string;
  readonly mapping: Pick<LinearMappingResolution, "projectRef"> | null;
  readonly projects: ReadonlyArray<P>;
}): P | undefined {
  const { mapping } = input;
  if (mapping === null) return undefined;
  return input.projects.find(
    (project) => project.environmentId === input.environmentId && project.id === mapping.projectRef,
  );
}

/**
 * Everything a chat started from an issue needs: the attached context record, where it runs, the
 * prompt, and the draft record. `formatReference` renders the client's inline chip for the record.
 */
export function buildLinearChatLaunchPlan(input: {
  readonly detail: LinearIssueDetail;
  readonly settings: LinearSettings;
  readonly mapping: LinearMappingResolution | null;
  readonly workspace: LinearLaunchWorkspace;
  readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
  readonly formatReference: (record: ReturnType<typeof buildLinearIssueContextRecord>) => string;
}) {
  const { detail, settings } = input;
  const record = buildLinearIssueContextRecord(detail, {
    subIssues: settings.includeSubIssues,
    comments: settings.includeComments,
    linkedPrs: settings.includeLinkedPrs,
  });
  return {
    record,
    workspace: resolveLinearChatWorkspace({
      workspace: input.workspace,
      baseBranch: input.mapping?.baseBranch ?? null,
    }),
    prompt: `${input.formatReference(record)}\n\n${buildLinearIssuePrompt(detail.issue)}`,
    draftIssue: buildDraftLinearIssue({
      detail,
      settings,
      teamStates: input.teamStates,
      mapping: input.mapping,
    }),
  };
}
