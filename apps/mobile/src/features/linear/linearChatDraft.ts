import {
  resolveLinearChatLaunch,
  type LinearChatLaunchPlan,
  type LinearLaunchWorkspace,
} from "@t3tools/client-runtime/linear/launch-plan";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

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
  readonly plan: LinearChatLaunchPlan;
}): Promise<string> {
  const { plan } = input;
  await waitForComposerDraftsLoaded();
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
  const launch = resolveLinearChatLaunch({
    environmentId,
    detail,
    settings,
    teamStates: teamResult._tag === "Success" ? teamResult.value.states : null,
    projects: appAtomRegistry.get(environmentProjects.projectsAtom),
    chosenProjectId: input.projectId,
    workspace: input.workspace,
    formatReference: formatComposerContextReference,
  });
  if (launch.kind === "needs-project") return launch;
  const draftKey = await createLinearChatDraft({
    environmentId,
    projectId: launch.projectId,
    plan: launch.plan,
  });
  return {
    kind: "opened",
    draftKey,
    projectId: launch.projectId,
    identifier: detail.issue.identifier,
  };
}
