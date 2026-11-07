import { useAtomValue } from "@effect/atom-react";
import { canLoadBalanceToEnvironment } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type ComposerContextRecord,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { isNewTaskModelSelectionBlocked } from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  composerContextImportsAtom,
  type ComposerDraftWorkspaceSelection,
  getComposerDraftSnapshot,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { useLoadBalancedEnvironment } from "../../state/use-load-balanced-environment";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { HomeProjectScope } from "../home/homeThreadList";
import type { NewTaskFlowState } from "./new-task-flow-state";
import { resolveAutoBalanceStatus, resolveBalancedProjects } from "./new-task-project-selection";

const EMPTY_LOAD_BALANCING_WEIGHTS: Readonly<Record<string, number>> = {};
const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];
const EMPTY_PROJECTS: ReadonlyArray<EnvironmentProject> = [];
const EMPTY_CONTEXT_RECORDS: ReadonlyArray<ComposerContextRecord> = [];
const NO_LINKED_ENVIRONMENTS: ReadonlyMap<EnvironmentId, string> = new Map();

/** Routes a new-task draft to the eligible machine with the most free resources. */
export function useNewTaskAutoBalance(input: {
  readonly active: boolean;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedProject: EnvironmentProject | null;
  readonly selectedProjectKey: string | null;
  readonly draftKey: string | null;
  readonly isScratchDraft: boolean;
  readonly environmentPinned: boolean;
  readonly loadBalancedEnvironmentId: EnvironmentId | null;
  readonly attachmentCount: number;
  readonly prompt: string;
  readonly contextRecords: ReadonlyArray<ComposerContextRecord> | undefined;
  /** The links of the machine the draft is on. */
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly selectedModel: ModelSelection | null;
  readonly storedModelSelection: ModelSelection | undefined;
  readonly selectedProviderDriver: string | null;
  readonly workspaceMode: "local" | "worktree";
  readonly defaultWorkspaceModeSettled: boolean;
  readonly readFlow: () => NewTaskFlowState;
  readonly updateFlow: (patch: Partial<NewTaskFlowState>) => void;
  readonly carryDraftContentTo: (project: EnvironmentProject) => string;
}) {
  const {
    active,
    projectScopes,
    selectedProject,
    selectedProjectKey,
    draftKey,
    isScratchDraft,
    environmentPinned,
    loadBalancedEnvironmentId,
    attachmentCount,
    prompt,
    contextRecords,
    linkedEnvironments,
    selectedModel,
    storedModelSelection,
    selectedProviderDriver,
    workspaceMode,
    defaultWorkspaceModeSettled,
    readFlow,
    updateFlow,
    carryDraftContentTo,
  } = input;
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // Only the current machine's links are loaded, so others count only their own threads.
  const linksOf = (environmentId: EnvironmentId) =>
    environmentId === selectedProject?.environmentId ? linkedEnvironments : NO_LINKED_ENVIRONMENTS;

  // Keeps the checkout-or-worktree choice but drops the branch and path, which
  // only mean something on the machine they were picked on.
  const releaseWorkspaceSelectionFromMachine = (
    draftKey: string,
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => {
    if (!selection) return;
    // Every machine resolves a pull request's head branch for itself at send.
    if (selection.pullRequestReference !== undefined) {
      updateComposerDraftSettings(draftKey, {
        workspaceSelection: { ...selection, worktreePath: null },
      });
      return;
    }
    updateComposerDraftSettings(draftKey, {
      workspaceSelection: {
        mode: selection.mode,
        branch: null,
        worktreePath: null,
        ...(selection.startFromOrigin !== undefined
          ? { startFromOrigin: selection.startFromOrigin }
          : {}),
        ...(selection.mode === "local" ? { followsCurrentCheckout: true } : {}),
      },
    });
  };

  const loadBalancingPreferences = useAtomValue(mobilePreferencesAtom);
  const loadBalancingEnabled =
    AsyncResult.isSuccess(loadBalancingPreferences) &&
    loadBalancingPreferences.value.loadBalancingEnabled === true;
  const loadBalancingWeights =
    (AsyncResult.isSuccess(loadBalancingPreferences)
      ? loadBalancingPreferences.value.loadBalancingWeights
      : undefined) ?? EMPTY_LOAD_BALANCING_WEIGHTS;
  const balancedProjects = resolveBalancedProjects(projectScopes, selectedProject);
  // Only a project the user chose is routed, and only while its draft is open.
  const canAutoBalance =
    active &&
    loadBalancingEnabled &&
    selectedProjectKey !== null &&
    !isScratchDraft &&
    balancedProjects.length > 1;
  const needsLoadBalancing =
    canAutoBalance &&
    !environmentPinned &&
    loadBalancedEnvironmentId === null &&
    attachmentCount === 0;
  const operableEnvironments = useEnvironmentsWithScope(
    needsLoadBalancing ? balancedProjects : EMPTY_PROJECTS,
    AuthOrchestrationOperateScope,
  );
  const selectedModelInstanceId = selectedModel?.instanceId;
  const selectedModelName = selectedModel?.model;
  const loadBalancingCandidates = needsLoadBalancing
    ? balancedProjects.flatMap(({ environmentId, id }) =>
        (loadBalancingWeights[environmentId] ?? 50) > 0 &&
        threadContextsOutsideEnvironment({
          text: prompt,
          records: contextRecords ?? EMPTY_CONTEXT_RECORDS,
          environmentId,
          linkedEnvironments: linksOf(environmentId),
        }).length === 0 &&
        // Resource checks only need read access; starting a task needs more.
        operableEnvironments.has(environmentId) &&
        connectedEnvironments.some(
          (environment) =>
            environment.environmentId === environmentId &&
            environment.connectionState === "connected",
        ) &&
        canLoadBalanceToEnvironment({
          providers: serverConfigs.get(environmentId)?.providers,
          settings: serverConfigs.get(environmentId)?.settings,
          projectId: id,
          providerInstanceId: selectedModelInstanceId ?? null,
          providerDriver: selectedProviderDriver,
        }) &&
        // The same checks the start button applies once the draft is there.
        !isNewTaskModelSelectionBlocked(
          serverConfigs.get(environmentId),
          selectedModelInstanceId !== undefined && selectedModelName !== undefined
            ? { instanceId: selectedModelInstanceId, model: selectedModelName }
            : null,
          id,
        ) &&
        // A pick this machine can't run stands aside here but returns on the destination.
        !isNewTaskModelSelectionBlocked(
          serverConfigs.get(environmentId),
          storedModelSelection ?? null,
          id,
        )
          ? [environmentId]
          : [],
      )
    : EMPTY_ENVIRONMENT_IDS;
  const loadBalancing = useLoadBalancedEnvironment(loadBalancingCandidates, loadBalancingWeights);
  // A pasted context lands after its files copy and may reference a thread on
  // this machine, so routing waits for it.
  const contextImports = useAtomValue(composerContextImportsAtom);
  const importingContext = draftKey !== null && contextImports[draftKey] === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the draft once the asynchronous host resource checks pick a machine
  useEffect(() => {
    if (
      !needsLoadBalancing ||
      loadBalancing.pending ||
      loadBalancing.environmentId === null ||
      importingContext ||
      selectedProject === null ||
      draftKey === null
    ) {
      return;
    }
    // A pin, project change, send, or import begun earlier in this commit has not rendered yet.
    const live = readFlow();
    if (
      live.environmentPinned ||
      live.loadBalancedEnvironmentId !== null ||
      live.projectKey !== selectedProjectKey ||
      live.submitting ||
      appAtomRegistry.get(composerContextImportsAtom)[draftKey] === true
    ) {
      return;
    }
    const target = balancedProjects.find(
      (project) => project.environmentId === loadBalancing.environmentId,
    );
    if (!target) return;
    const liveDraft = getComposerDraftSnapshot(draftKey);
    if (liveDraft.attachments.length > 0) return;
    if (
      threadContextsOutsideEnvironment({
        text: liveDraft.text,
        records: liveDraft.context?.records ?? EMPTY_CONTEXT_RECORDS,
        environmentId: target.environmentId,
        linkedEnvironments: linksOf(target.environmentId),
      }).length > 0
    ) {
      return;
    }
    const movesMachine = target.environmentId !== selectedProject.environmentId;
    // The mode on screen travels even when it is only this machine's default, as on web.
    const workspaceSelection =
      liveDraft.workspaceSelection ??
      (defaultWorkspaceModeSettled
        ? { mode: workspaceMode, branch: null, worktreePath: null }
        : undefined);
    if (movesMachine && workspaceSelection === undefined) return;
    const movedDraftKey = carryDraftContentTo(target);
    if (movesMachine) {
      releaseWorkspaceSelectionFromMachine(movedDraftKey, workspaceSelection);
    }
    updateFlow({
      draftKey: movedDraftKey,
      environmentId: target.environmentId,
      projectKey: scopedProjectKey(target.environmentId, target.id),
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    importingContext,
    balancedProjects,
    carryDraftContentTo,
    defaultWorkspaceModeSettled,
    readFlow,
    releaseWorkspaceSelectionFromMachine,
    selectedProject,
    draftKey,
    linksOf,
    selectedProjectKey,
    updateFlow,
    workspaceMode,
  ]);
  const autoBalanceStatus = resolveAutoBalanceStatus({
    canAutoBalance,
    environmentPinned,
    hasAttachments: attachmentCount > 0,
    loadBalancedEnvironmentId,
    pending: loadBalancing.pending || !defaultWorkspaceModeSettled || importingContext,
  });
  const refreshLoadBalancing = loadBalancing.refresh;
  const selectAutoBalance = () => {
    if (attachmentCount > 0) {
      Dialog.alert(
        "Keep attachments on this machine",
        "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      );
      return false;
    }
    refreshLoadBalancing(balancedProjects.map((project) => project.environmentId));
    if (draftKey) {
      releaseWorkspaceSelectionFromMachine(
        draftKey,
        getComposerDraftSnapshot(draftKey).workspaceSelection,
      );
    }
    updateFlow({ environmentPinned: false, loadBalancedEnvironmentId: null });
    return true;
  };

  return { canAutoBalance, autoBalanceStatus, selectAutoBalance };
}
