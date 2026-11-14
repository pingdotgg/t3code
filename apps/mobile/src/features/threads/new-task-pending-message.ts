import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import {
  type ComposerDraftWorkspaceSelection,
  getComposerDraftSnapshot,
} from "../../state/use-composer-drafts";
import { resolvePendingTaskInteractionMode } from "../../state/legacy-plan-mode";
import { resolveNewTaskDraftWorkspace } from "./new-task-context-presentation";
import { resolveNewThreadRuntimeMode } from "./thread-settings-options";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import { resolveSelectableModelSelection } from "../../lib/modelOptions";
import type { QueuedThreadMessage } from "../../state/thread-outbox";

export interface PendingTaskMessageContext {
  readonly selectedProject: EnvironmentProject | null;
  readonly selectedProjectDraftKey: string | null;
  readonly selectedEnvironmentServerConfig: Parameters<typeof resolveSelectableModelSelection>[0];
  readonly selectedModel: ReturnType<typeof resolveSelectableModelSelection>;
  readonly linkedEnvironments: Parameters<
    typeof threadContextsOutsideEnvironment
  >[0]["linkedEnvironments"];
  readonly resolveWorkspaceSelection: (
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => ReturnType<typeof resolveNewTaskDraftWorkspace>;
  readonly defaultRuntimeMode: Parameters<typeof resolveNewThreadRuntimeMode>[1];
  readonly managedPolicy: Parameters<typeof resolveNewThreadRuntimeMode>[2];
  readonly legacyPlanModeEnabled: boolean;
  readonly startFromOrigin: boolean;
}

/** The queued message a draft becomes when it starts while its environment is offline. */
export function buildPendingTaskMessage(
  context: PendingTaskMessageContext,
  metadata: TurnCommandMetadata,
  options?: { readonly currentCheckoutBranch?: string | null },
): QueuedThreadMessage | null {
  const { selectedProject, selectedProjectDraftKey } = context;
  if (!selectedProject || !selectedProjectDraftKey) {
    return null;
  }
  const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
  const text = draft.text.trim();
  const draftModelSelection =
    resolveSelectableModelSelection(
      context.selectedEnvironmentServerConfig,
      draft.modelSelection ?? null,
      selectedProject.id,
    ) ?? context.selectedModel;
  if ((text.length === 0 && draft.attachments.length === 0) || !draftModelSelection) {
    return null;
  }
  if (
    threadContextsOutsideEnvironment({
      text: draft.text,
      records: draft.context?.records ?? [],
      environmentId: selectedProject.environmentId,
      linkedEnvironments: context.linkedEnvironments,
    }).length > 0
  ) {
    return null;
  }
  const workspaceSelection = context.resolveWorkspaceSelection(draft.workspaceSelection);
  const mode = workspaceSelection.mode;
  return {
    environmentId: selectedProject.environmentId,
    threadId: ThreadId.make(metadata.threadId),
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text,
    attachments: draft.attachments,
    context: draft.context,
    modelSelection: draftModelSelection,
    runtimeMode: resolveNewThreadRuntimeMode(
      draft.runtimeMode,
      context.defaultRuntimeMode,
      context.managedPolicy,
    ),
    interactionMode: resolvePendingTaskInteractionMode({
      planModeEnabled: context.legacyPlanModeEnabled,
      draftInteractionMode: draft.interactionMode,
      provider: context.selectedEnvironmentServerConfig?.providers.find(
        (candidate) => candidate.instanceId === draftModelSelection.instanceId,
      ),
    }),
    creation: {
      projectId: selectedProject.id,
      projectTitle: selectedProject.title,
      projectCwd: selectedProject.workspaceRoot,
      workspaceMode: mode,
      ...(mode === "worktree" && workspaceSelection?.pullRequestReference
        ? { pullRequestReference: workspaceSelection.pullRequestReference }
        : {}),
      // Queued local tasks use drain-time checkout; snapshot branches only for immediate sends or explicit choices.
      branch: resolveProjectThreadCreationBranch({
        workspaceMode: mode,
        selectedBranch: workspaceSelection?.branch ?? null,
        currentCheckoutBranch: options?.currentCheckoutBranch ?? null,
      }),
      worktreePath: mode === "worktree" ? null : (workspaceSelection?.worktreePath ?? null),
      ...((workspaceSelection?.startFromOrigin ?? context.startFromOrigin)
        ? { startFromOrigin: true }
        : {}),
    },
    createdAt: metadata.createdAt,
  };
}
