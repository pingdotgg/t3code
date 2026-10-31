import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearSettings,
  type LinearWorkflowState,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildLinearIssueMarkdown,
  formatTokenEstimate,
  linearIssueIncludeCounts,
  resolveLinearMapping,
  resolveLinearMoveTarget,
  type LinearIssueIncludes,
} from "@t3tools/shared/linearLaunch";

import type { LinearWriteBackRoute } from "./pipelineMachines.ts";
import {
  linearWriteBackOf,
  type LinearDraftIssue,
  type LinearLaunchWorkspace,
  type RecordLinearLaunchInput,
} from "./launchPlan.ts";

// Pipelines have a different id on every machine, so the last used one is remembered by name.
const LAST_USED_PIPELINE_KEY = "t3code:linear:last-pipeline-name:v1";

/** The pipeline last started from an issue on this device; null when none or storage fails. */
export function readLastUsedPipelineName(
  storage: Pick<Storage, "getItem"> | undefined,
): string | null {
  try {
    return storage?.getItem(LAST_USED_PIPELINE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLastUsedPipelineName(
  storage: Pick<Storage, "setItem"> | undefined,
  pipelineName: string,
): void {
  try {
    storage?.setItem(LAST_USED_PIPELINE_KEY, pipelineName);
  } catch {
    // The "Last used" hint is a convenience; losing it must not block a launch.
  }
}

export function includesFromSettings(
  settings: Pick<LinearSettings, "includeSubIssues" | "includeComments" | "includeLinkedPrs">,
): LinearIssueIncludes {
  return {
    subIssues: settings.includeSubIssues,
    comments: settings.includeComments,
    linkedPrs: settings.includeLinkedPrs,
  };
}

/** The text the first step receives. Text the person edited wins over the generated version. */
export function pipelineInputText(input: {
  readonly detail: LinearIssueDetail;
  readonly includes: LinearIssueIncludes;
  readonly edited: string | null;
}): string {
  return input.edited ?? buildLinearIssueMarkdown(input.detail, input.includes);
}

/** Include counts and size of the input; `startable` when it is non-empty and within the limit. */
export function pipelineInputSummary(input: {
  readonly detail: LinearIssueDetail;
  readonly text: string;
}) {
  const tokens = formatTokenEstimate(input.text.length);
  const overLimit = input.text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  return {
    counts: linearIssueIncludeCounts(input.detail),
    tokens,
    overLimit,
    startable: input.text.trim().length > 0 && !overLimit,
    sizeLabel: overLimit
      ? `${tokens} · over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} character limit`
      : tokens,
  };
}

/**
 * The run's project and write-backs: what the person picked, else what the mapping and settings
 * say. The mapped base branch applies only while the mapped project is the one chosen.
 */
export function resolvePipelineLaunch(input: {
  readonly issue: Pick<LinearIssue, "team" | "project" | "state">;
  readonly settings: Pick<
    LinearSettings,
    "mappings" | "moveToStateId" | "moveToStateEnabled" | "commentEnabled"
  >;
  readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly choices: {
    readonly projectId: ProjectId | null;
    readonly move: boolean | null;
    readonly comment: boolean | null;
  };
}) {
  const { issue, settings, choices } = input;
  const mapping = resolveLinearMapping(issue, settings.mappings);
  const mappedProjectId =
    mapping !== null && input.projectIds.includes(mapping.projectRef) ? mapping.projectRef : null;
  const projectId = choices.projectId ?? mappedProjectId;
  const moveTarget =
    input.teamStates === null
      ? null
      : resolveLinearMoveTarget({
          currentStateType: issue.state.type,
          teamStates: input.teamStates,
          preferredStateId: settings.moveToStateId,
        });
  return {
    mappedProjectId,
    projectId,
    mappedBaseBranch:
      projectId !== null && projectId === mappedProjectId && mapping?.baseBranch
        ? mapping.baseBranch
        : null,
    moveTarget,
    moveEnabled: (choices.move ?? settings.moveToStateEnabled) && moveTarget !== null,
    commentEnabled: choices.comment ?? settings.commentEnabled,
  };
}

/** The launch record for a pipeline run started from an issue. */
export function pipelineLaunchRecord(input: {
  readonly environmentId: EnvironmentId;
  readonly issue: Pick<LinearIssue, "id" | "identifier" | "title" | "team" | "project">;
  readonly pipelineName: string;
  readonly run: { readonly id: string; readonly parentThreadId: ThreadId };
  readonly writeBack: Pick<LinearDraftIssue, "moveTo" | "moveEnabled" | "commentEnabled">;
  /** Where the launch is recorded; omitted when the run's own machine records it. */
  readonly route?: LinearWriteBackRoute;
}): RecordLinearLaunchInput {
  const { issue, route } = input;
  return {
    environmentId: input.environmentId,
    ...(route === undefined ? {} : { recordOn: route.recordOn }),
    ...(route?.kind === "fallback"
      ? { remote: { machineName: route.machineName, pipelineName: input.pipelineName } }
      : {}),
    issueId: issue.id,
    identifier: issue.identifier,
    teamId: issue.team.id,
    projectId: issue.project?.id,
    target: {
      kind: "pipeline_run",
      targetId: input.run.id,
      threadId: input.run.parentThreadId,
      title: `${input.pipelineName}: ${issue.identifier} ${issue.title}`,
    },
    writeBack: linearWriteBackOf(input.writeBack),
  };
}

export function pipelineWorkspaceStrategy(input: {
  readonly workspace: LinearLaunchWorkspace;
  /** Mapped base branch, else the project's current branch. */
  readonly baseRef: string | null;
  readonly branchName: string;
}): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  if (input.workspace === "local") return { type: "root" };
  // "HEAD" starts the worktree where the checkout is when no branch is known yet.
  return {
    type: "worktree",
    baseRef: input.baseRef ?? "HEAD",
    ...(input.branchName.length > 0 ? { branch: input.branchName } : {}),
  };
}
