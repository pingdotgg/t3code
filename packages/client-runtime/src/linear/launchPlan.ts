import type {
  EnvironmentId,
  LinearIssueDetail,
  LinearLaunchTarget,
  LinearRecordLaunchInput,
  LinearSettings,
  LinearWorkflowState,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildLinearIssueContextRecord,
  buildLinearIssuePrompt,
  resolveLinearMapping,
  resolveLinearMoveTarget,
  type LinearMappingResolution,
} from "@t3tools/shared/linearLaunch";
import * as Schema from "effect/Schema";

export type LinearLaunchWorkspace = "worktree" | "local";

/** What an issue view can start; each client opens its own draft and pipeline sheet or dialog. */
export interface LinearLaunchActions {
  startChat(issueId: string, options?: { readonly workspace?: LinearLaunchWorkspace }): void;
  openPipeline(issueId: string, pipelineId?: string): void;
}

/** A draft started from a Linear issue: what to record, and write back, once it is sent. */
export const LinearDraftIssue = Schema.Struct({
  issueId: Schema.String,
  identifier: Schema.String,
  /** Lets the launch still be linked when Linear can't be read at send time. */
  teamId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  /** The issue's Linear branch name; the new worktree takes it. */
  branchName: Schema.String,
  /** The T3 project the mapping chose, for the "from mapping" hint; null when unmapped. */
  mappedProjectId: Schema.NullOr(Schema.String),
  /** The state this launch moves the issue to; null when the issue is not eligible. */
  moveTo: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  moveEnabled: Schema.Boolean,
  commentEnabled: Schema.Boolean,
});
export type LinearDraftIssue = typeof LinearDraftIssue.Type;

export interface RecordLinearLaunchInput {
  readonly environmentId: EnvironmentId;
  readonly issueId: string;
  readonly identifier: string;
  /** Ids the client already holds, so the launch is linked even when Linear can't be read. */
  readonly teamId: string | undefined;
  readonly projectId: string | undefined;
  readonly target: LinearLaunchTarget;
  readonly writeBack: LinearRecordLaunchInput["writeBack"];
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

/** The launch record for the thread a draft started from an issue became once sent. */
export function linearChatLaunchRecord(input: {
  readonly environmentId: EnvironmentId;
  readonly draftIssue: LinearDraftIssue;
  readonly threadId: ThreadId;
  readonly title: string;
}): RecordLinearLaunchInput {
  const { draftIssue } = input;
  return {
    environmentId: input.environmentId,
    issueId: draftIssue.issueId,
    identifier: draftIssue.identifier,
    teamId: draftIssue.teamId,
    projectId: draftIssue.projectId,
    target: {
      kind: "thread",
      targetId: input.threadId,
      threadId: input.threadId,
      title: input.title,
    },
    writeBack: linearWriteBackOf(draftIssue),
  };
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

export type LinearChatLaunchPlan = ReturnType<typeof buildLinearChatLaunchPlan>;

/**
 * Where a chat from an issue starts. A project picked by hand wins and is not "from mapping";
 * otherwise the mapping decides, and without a mapped project in this environment the client asks.
 */
export function resolveLinearChatLaunch(input: {
  readonly environmentId: EnvironmentId;
  readonly detail: LinearIssueDetail;
  readonly settings: LinearSettings;
  readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly environmentId: string }>;
  readonly chosenProjectId: ProjectId | undefined;
  readonly workspace: LinearLaunchWorkspace | undefined;
  readonly formatReference: (record: ReturnType<typeof buildLinearIssueContextRecord>) => string;
}):
  | { readonly kind: "needs-project" }
  | { readonly kind: "ready"; readonly projectId: ProjectId; readonly plan: LinearChatLaunchPlan } {
  const mapping =
    input.chosenProjectId === undefined
      ? resolveLinearMapping(input.detail.issue, input.settings.mappings)
      : null;
  const projectId =
    input.chosenProjectId ??
    findLinearMappedProject({
      environmentId: input.environmentId,
      mapping,
      projects: input.projects,
    })?.id;
  if (projectId === undefined) return { kind: "needs-project" };
  return {
    kind: "ready",
    projectId,
    plan: buildLinearChatLaunchPlan({
      detail: input.detail,
      settings: input.settings,
      mapping,
      workspace: input.workspace ?? input.settings.defaultWorkspace,
      teamStates: input.teamStates,
      formatReference: input.formatReference,
    }),
  };
}
