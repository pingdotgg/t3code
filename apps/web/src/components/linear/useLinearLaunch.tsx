import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type LinearIssueDetail,
  type LinearSettings,
  type LinearWorkflowState,
  type ProjectId,
} from "@t3tools/contracts";
import {
  buildLinearIssueContextRecord,
  buildLinearIssuePrompt,
  resolveLinearMapping,
  type LinearMappingResolution,
} from "@t3tools/shared/linearLaunch";
import { type ReactNode, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useStableCallback } from "../../hooks/useStableCallback";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { linearContextReference } from "../../lib/composerContextRecords";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProjects, useProjects } from "../../state/entities";
import { linearEnvironment } from "../../state/linear";
import { environmentServerConfigsAtom } from "../../state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { LinearPipelineDialog } from "./LinearPipelineDialog";
import { LinearProjectSelect } from "./LinearProjectSelect";
import { buildDraftLinearIssue, resolveLinearChatWorkspace } from "./linearLaunch.logic";
import {
  type LinearLaunchActions,
  LinearLaunchActionsProvider,
  type LinearLaunchWorkspace,
} from "./linearLaunchTypes";
import { useLinearEnvironmentId } from "./useLinearData";

const QUIET = { reportFailure: false, reportDefect: false } as const;

function readLinearSettings(environmentId: EnvironmentId): LinearSettings {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.settings.linear ??
    DEFAULT_SERVER_SETTINGS.linear
  );
}

async function readTeamStates(
  environmentId: EnvironmentId,
  teamId: string,
): Promise<ReadonlyArray<LinearWorkflowState> | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    linearEnvironment.teamMetadata({ environmentId, input: { teamId } }),
    QUIET,
  );
  return result._tag === "Success" ? result.value.states : null;
}

interface PendingProjectChoice {
  readonly environmentId: EnvironmentId;
  readonly detail: LinearIssueDetail;
  readonly settings: LinearSettings;
  readonly workspace: LinearLaunchWorkspace;
  readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
}

/** Opens a new-thread draft for the issue: project, workspace, attached snapshot and prompt. */
function useOpenLinearChatDraft() {
  const newThread = useNewThreadHandler();
  return useStableCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly mapping: LinearMappingResolution | null;
      readonly detail: LinearIssueDetail;
      readonly settings: LinearSettings;
      readonly workspace: LinearLaunchWorkspace;
      readonly teamStates: ReadonlyArray<LinearWorkflowState> | null;
    }) => {
      const { detail, settings } = input;
      const record = buildLinearIssueContextRecord(detail, {
        subIssues: settings.includeSubIssues,
        comments: settings.includeComments,
        linkedPrs: settings.includeLinkedPrs,
      });
      const workspace = resolveLinearChatWorkspace({
        workspace: input.workspace,
        baseBranch: input.mapping?.baseBranch ?? null,
      });
      const prompt = `${formatInlineContextReference(linearContextReference(record))}\n\n${buildLinearIssuePrompt(detail.issue)}`;
      const opened = await newThread(scopeProjectRef(input.environmentId, input.projectId), {
        ...workspace,
        prompt,
      }).then(
        (result) => result,
        () => null,
      );
      if (opened === null) {
        toastManager.add({
          type: "error",
          title: `Could not open a chat for ${detail.issue.identifier}`,
          description: "Try again from the project, or open a thread first.",
        });
        return;
      }
      const store = useComposerDraftStore.getState();
      store.addLinearContexts(opened.draftId, [record], { appendReference: false });
      store.setDraftLinearIssue(
        opened.draftId,
        buildDraftLinearIssue({
          detail,
          settings,
          teamStates: input.teamStates,
          mapping: input.mapping,
        }),
      );
    },
  );
}

function useStartLinearChat(
  askForProject: (choice: PendingProjectChoice) => void,
): LinearLaunchActions["startChat"] {
  const environmentId = useLinearEnvironmentId();
  const openDraft = useOpenLinearChatDraft();
  return useStableCallback((issueId: string, options?: { workspace?: LinearLaunchWorkspace }) => {
    if (environmentId === null) return;
    void (async () => {
      const detailResult = await executeAtomQuery(
        appAtomRegistry,
        linearEnvironment.issueDetail({ environmentId, input: { issueId } }),
        QUIET,
      );
      if (detailResult._tag === "Failure") {
        const failure = squashAtomCommandFailure(detailResult);
        toastManager.add({
          type: "error",
          title: "Could not load the issue",
          description: failure instanceof Error ? failure.message : undefined,
        });
        return;
      }
      const detail = detailResult.value;
      const settings = readLinearSettings(environmentId);
      const workspace = options?.workspace ?? settings.defaultWorkspace;
      const teamStates = await readTeamStates(environmentId, detail.issue.team.id);
      const mapping = resolveLinearMapping(detail.issue, settings.mappings);
      const mappedProject =
        mapping === null
          ? undefined
          : readProjects().find(
              (project) =>
                project.environmentId === environmentId && project.id === mapping.projectRef,
            );
      if (mapping === null || mappedProject === undefined) {
        askForProject({ environmentId, detail, settings, workspace, teamStates });
        return;
      }
      await openDraft({
        environmentId,
        projectId: mappedProject.id,
        mapping,
        detail,
        settings,
        workspace,
        teamStates,
      });
    })();
  });
}

function ProjectChoiceDialog({
  choice,
  onClose,
}: {
  readonly choice: PendingProjectChoice;
  readonly onClose: () => void;
}) {
  const openDraft = useOpenLinearChatDraft();
  const projects = useProjects().filter(
    (project) => project.environmentId === choice.environmentId,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const { issue } = choice.detail;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Which project is {issue.identifier} in?</DialogTitle>
          <DialogDescription>
            No Linear mapping covers {issue.team.name}
            {issue.project ? ` or ${issue.project.name}` : ""}. Add one in Settings to skip this
            step next time.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <LinearProjectSelect
            projects={projects}
            value={projectId}
            onValueChange={setProjectId}
            size="default"
            className="w-full"
          />
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={projectId === null}
            onClick={() => {
              if (projectId === null) return;
              onClose();
              void openDraft({ ...choice, projectId, mapping: null });
            }}
          >
            Open chat
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Provides the issue launch actions (start a chat, run a pipeline) to the Linear page and hosts
 * the dialogs they open.
 */
export function LinearLaunchProvider({ children }: { readonly children: ReactNode }) {
  const [projectChoice, setProjectChoice] = useState<PendingProjectChoice | null>(null);
  const [pipelineRequest, setPipelineRequest] = useState<{
    readonly issueId: string;
    readonly pipelineId: string | undefined;
  } | null>(null);
  const startChat = useStartLinearChat(setProjectChoice);
  const openPipelineDialog = useStableCallback((issueId: string, pipelineId?: string) =>
    setPipelineRequest({ issueId, pipelineId }),
  );
  const actions: LinearLaunchActions = { startChat, openPipelineDialog };
  return (
    <LinearLaunchActionsProvider value={actions}>
      {children}
      {projectChoice !== null ? (
        <ProjectChoiceDialog choice={projectChoice} onClose={() => setProjectChoice(null)} />
      ) : null}
      {pipelineRequest !== null ? (
        <LinearPipelineDialog
          issueId={pipelineRequest.issueId}
          initialPipelineId={pipelineRequest.pipelineId}
          onClose={() => setPipelineRequest(null)}
        />
      ) : null}
    </LinearLaunchActionsProvider>
  );
}
