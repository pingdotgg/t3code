import {
  buildLinearChatLaunchPlan,
  findLinearMappedProject,
  type LinearLaunchWorkspace,
} from "@t3tools/client-runtime/linear/launch-plan";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type LinearIssueDetail,
  type LinearSettings,
  type LinearWorkflowState,
  type ProjectId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { resolveLinearMapping, type LinearMappingResolution } from "@t3tools/shared/linearLaunch";

import { appAtomRegistry } from "../../state/atom-registry";
import { linearEnvironment } from "../../state/linear";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  createNewTaskDraft,
  setComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linearDraftWorkspaceSelection, linearSettingsOf } from "./linearLaunchHelpers";

/** Creates the new-task draft for an issue: project, workspace, attached snapshot and prompt. */
async function createLinearChatDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly detail: LinearIssueDetail;
  readonly settings: LinearSettings;
  readonly mapping: LinearMappingResolution | null;
  readonly workspace: LinearLaunchWorkspace;
  readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
}): Promise<string> {
  await waitForComposerDraftsLoaded();
  const plan = buildLinearChatLaunchPlan({
    detail: input.detail,
    settings: input.settings,
    mapping: input.mapping,
    workspace: input.workspace,
    teamStates: input.teamStates,
    formatReference: formatComposerContextReference,
  });
  const draftKey = createNewTaskDraft({
    environmentId: input.environmentId,
    projectId: input.projectId,
  });
  // Text first: setting it drops any context the text does not reference yet.
  setComposerDraftText(draftKey, plan.prompt);
  setComposerDraftContext(draftKey, { version: 1, records: [plan.record] });
  updateComposerDraftSettings(draftKey, {
    workspaceSelection: linearDraftWorkspaceSelection(plan.workspace),
    linearIssue: plan.draftIssue,
  });
  return draftKey;
}

const QUIET = { reportFailure: false, reportDefect: false } as const;

type LinearChatDraftStart =
  | {
      readonly kind: "opened";
      readonly draftKey: string;
      readonly projectId: ProjectId;
      readonly identifier: string;
    }
  | { readonly kind: "needs-project" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Prepares a chat for an issue. Without a project, the issue's mapping decides; when none
 * resolves to a project in this environment the caller asks for one.
 */
export async function startLinearChatDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly issueId: string;
  readonly workspace: LinearLaunchWorkspace | undefined;
  readonly projectId: ProjectId | undefined;
}): Promise<LinearChatDraftStart> {
  const { environmentId } = input;
  const detailResult = await executeAtomQuery(
    appAtomRegistry,
    linearEnvironment.issueDetail({ environmentId, input: { issueId: input.issueId } }),
    QUIET,
  );
  if (detailResult._tag === "Failure") {
    const failure = squashAtomCommandFailure(detailResult);
    return {
      kind: "failed",
      message: failure instanceof Error ? failure.message : "The issue could not be loaded.",
    };
  }
  const detail = detailResult.value;
  const settings = linearSettingsOf(
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
  );
  const teamResult = await executeAtomQuery(
    appAtomRegistry,
    linearEnvironment.teamMetadata({ environmentId, input: { teamId: detail.issue.team.id } }),
    QUIET,
  );
  const mapping = resolveLinearMapping(detail.issue, settings.mappings);
  const mappedProject = findLinearMappedProject({
    environmentId,
    mapping,
    projects: appAtomRegistry.get(environmentProjects.projectsAtom),
  });
  const projectId = input.projectId ?? mappedProject?.id;
  if (projectId === undefined) return { kind: "needs-project" };
  const draftKey = await createLinearChatDraft({
    environmentId,
    projectId,
    detail,
    settings,
    // A project chosen by hand is not "from mapping", and has no mapped base branch.
    mapping: input.projectId === undefined ? mapping : null,
    workspace: input.workspace ?? settings.defaultWorkspace,
    teamStates: teamResult._tag === "Success" ? teamResult.value.states : null,
  });
  return { kind: "opened", draftKey, projectId, identifier: detail.issue.identifier };
}
