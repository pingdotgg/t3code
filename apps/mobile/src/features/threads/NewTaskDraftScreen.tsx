import { DraftEnvironmentControl } from "./DraftEnvironmentControl";
import { NativeScrollEdgeEffectsContext } from "../../native/NativeScrollViewMarker";
import { DraftThreadHeader } from "./DraftThreadHeader";
import { threadHeaderAppearance } from "./thread-header-appearance";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useComposerAttachmentActions } from "../../state/use-composer-attachment-actions";
import { useWorkspaceBackNavigation } from "../workspace/useAndroidWorkspaceNavigation";
import { submittedThreadParams } from "./thread-route-state";
import { ThreadScreenBinding, ThreadScreenFallback } from "./ThreadScreenHost";
import { draftThreadShell } from "./draft-thread-shell";
import { useRememberThreadProject } from "./useRememberThreadProject";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { connectionTone } from "../connection/connectionTone";
import { AppBar } from "../../components/ui/AppBar";
import { ThreadId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommonActions,
  StackActions,
  useIsFocused,
  useNavigation,
  usePreventRemove,
  useRoute,
} from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { KeyboardController } from "react-native-keyboard-controller";

import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { composerContextImportsAtom } from "../../state/use-composer-drafts";
import { abortComposerDraftOperations } from "../../state/composerDraftOperations";
import { composerContextSendBlockReason } from "../../lib/composerContext";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";

import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  updateComposerDraftSettings,
  scheduleUnusedComposerAttachmentCleanup,
} from "../../state/use-composer-drafts";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useProjectClone } from "../../state/projectClones";
import { projectEnvironment } from "../../state/projects";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectCloneBanner } from "./ProjectCloneBanner";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import {
  useRemoteConnections,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  nextEnvironmentId,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import { resolveDraftProjectSelection } from "./new-task-project-selection";
import {
  resolveNewTaskBranchLabel,
  resolveNewTaskWorkspaceLabel,
} from "./new-task-context-presentation";
import { incomingShareImports, useIncomingShare } from "../sharing/IncomingShareProvider";
import { idleShareFlagAtom, idleShareImportPhaseAtom } from "./incomingShareImport";
import { newTaskFlowKey } from "./new-task-flow-state";
import { appAtomRegistry } from "../../state/atom-registry";

import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";

function NewTaskWorkspaceIcon(props: {
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly size: number;
}) {
  if (props.workspaceMode === "local" && props.worktreePath === null) {
    return (
      <SymbolView
        name="folder"
        size={props.size}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    );
  }

  const boxSize = (14 * props.size) / 16;
  return (
    <View
      className="size-4"
      style={Platform.OS === "android" ? { width: boxSize, height: boxSize } : undefined}
    >
      <SymbolView
        name="folder"
        size={props.size}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <View
        className="absolute -right-1 -bottom-1"
        style={
          Platform.OS === "android" ? { right: -boxSize / 4, bottom: -boxSize / 4 } : undefined
        }
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={Math.round((9 * props.size) / 16)}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </View>
    </View>
  );
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly cloning?: boolean;
  };
  readonly draftId?: string;
  readonly incomingShareId?: string;
}) {
  const [creationMetadata] = useState(makeTurnCommandMetadata);
  const projects = useProjects();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const goBack = useWorkspaceBackNavigation("threads");
  const currentRoute = useRoute();
  const flowKey = newTaskFlowKey(currentRoute);
  const { getShare, isLoading: isIncomingShareInboxLoading } = useIncomingShare();
  const { projectScopes, selectedProject, selectedProjectKey, setProject } = flow;
  // selectedProject falls back to the environment's first project; remember only a chosen one.
  useRememberThreadProject(
    selectedProject &&
      selectedProjectKey === scopedProjectKey(selectedProject.environmentId, selectedProject.id)
      ? selectedProject
      : null,
  );
  const selectedProjectLabel = (() => {
    if (!selectedProject) return null;
    const scope = projectScopes.find((candidate) =>
      candidate.projectRefs.some(
        (ref) =>
          ref.environmentId === selectedProject.environmentId &&
          ref.projectId === selectedProject.id,
      ),
    );
    return scope?.title ?? selectedProject.title;
  })();
  const { onReconnectEnvironment } = useRemoteConnections();
  const environmentRuntime = useRemoteEnvironmentRuntime(selectedProject?.environmentId ?? null);
  const connectionState = environmentRuntime?.connectionState ?? "offline";
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const environmentConnected = connectionState === "connected";
  const canOperate = useEnvironmentScope(
    selectedProject?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const projectCloneState = useProjectClone(
    selectedProject
      ? { environmentId: selectedProject.environmentId, projectId: selectedProject.id }
      : null,
  );
  const projectClone = projectCloneState === "pending" ? null : projectCloneState;
  const awaitingKnownClone =
    projectCloneState === "pending" &&
    props.initialProjectRef?.cloning === true &&
    selectedProject !== null &&
    selectedProject.id === props.initialProjectRef.projectId &&
    selectedProject.environmentId === props.initialProjectRef.environmentId;
  const cloneBlocksStart =
    awaitingKnownClone || (projectClone !== null && projectClone.phase !== "done");
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const runCloneAction = async (
    title: string,
    action: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
  ) => {
    const result = await action();
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      Dialog.alert(title, error instanceof Error ? error.message : "An error occurred.");
    }
  };
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });
  const removeClonedProject = async () => {
    if (!selectedProject) return;
    const removed = selectedProject;
    const result = await deleteProject({
      environmentId: removed.environmentId,
      input: { projectId: removed.id },
    });
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      Dialog.alert(
        "Failed to remove project",
        error instanceof Error ? error.message : "An error occurred.",
      );
      return;
    }
    if (flow.getSelectedProjectKey() === scopedProjectKey(removed.environmentId, removed.id)) {
      navigation.dispatch(StackActions.replace("Home"));
    }
  };
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentBlockReason = selectedProject
    ? composerAttachmentUploadBlockReason({
        environmentId: selectedProject.environmentId,
        attachments: flow.attachments,
        connected: environmentConnected,
        serverConfig: selectedEnvironmentServerConfig,
        states: uploadStates,
      })
    : null;
  const attachmentsUploading =
    environmentConnected &&
    selectedProject !== null &&
    composerAttachmentsStillUploading({
      environmentId: selectedProject.environmentId,
      attachments: flow.attachments,
      serverConfig: selectedEnvironmentServerConfig,
      states: uploadStates,
    });
  const queuesInsteadOfStarting = !environmentConnected || attachmentsUploading;
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const [isReturningToProjectPicker, setIsReturningToProjectPicker] = useState(false);
  const incomingShare = props.incomingShareId ? getShare(props.incomingShareId) : null;
  const requestedInitialProjectAvailable = Boolean(
    props.initialProjectRef?.environmentId &&
    props.initialProjectRef.projectId &&
    projects.some(
      (project) =>
        project.environmentId === props.initialProjectRef?.environmentId &&
        project.id === props.initialProjectRef?.projectId,
    ),
  );
  // A route naming a draft that is gone, or whose project is gone, also
  // returns to the picker.
  const isRouteDraftMissing =
    props.draftId !== undefined && flow.missingRouteDraftId === props.draftId;
  const isProjectPickerReturnActive =
    (isReturningToProjectPicker && !requestedInitialProjectAvailable) || isRouteDraftMissing;
  const isIncomingShareAwaitingServerConfig = Boolean(
    incomingShare?.attachments.some((attachment) => attachment.type === "file") &&
    selectedEnvironmentServerConfig === null,
  );
  const routeImportedShare = useAtomValue(
    flowKey !== undefined && props.incomingShareId
      ? incomingShareImports.importedAtom(flowKey, props.incomingShareId)
      : idleShareFlagAtom,
  );
  const hasImportedIncomingShare = Boolean(
    props.incomingShareId &&
    (routeImportedShare ||
      (flow.draftKey &&
        getComposerDraftSnapshot(flow.draftKey).importedShareIds?.includes(props.incomingShareId))),
  );
  const isIncomingShareUnavailable = Boolean(
    props.incomingShareId &&
    !isIncomingShareInboxLoading &&
    !incomingShare &&
    !hasImportedIncomingShare,
  );
  const shareImportTarget = (() => {
    if (!props.incomingShareId || flowKey === undefined || !flow.draftKey) return null;
    if (!selectedProject || !incomingShare || isIncomingShareAwaitingServerConfig) return null;
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    if (
      initialEnvironmentId &&
      initialProjectId &&
      (selectedProject.environmentId !== initialEnvironmentId ||
        selectedProject.id !== initialProjectId)
    ) {
      return null;
    }
    return {
      flowKey,
      routeKey: currentRoute.key,
      draftKey: flow.draftKey,
      destination: {
        environmentId: String(selectedProject.environmentId),
        projectId: String(selectedProject.id),
      },
      shareId: incomingShare.id,
    };
  })();
  const shareImportPhase = useAtomValue(
    shareImportTarget === null
      ? idleShareImportPhaseAtom
      : incomingShareImports.phaseAtom(shareImportTarget),
  );
  // Locks on the route, not the target: the target turns null when server config
  // drops or the project stops matching, while the import keeps writing the draft.
  const isImportingShare = useAtomValue(
    flowKey === undefined ? idleShareFlagAtom : incomingShareImports.inFlightAtom(flowKey),
  );
  const isIncomingShareTransferPending = Boolean(
    incomingShare && shareImportPhase !== "cancelled" && !isIncomingShareAwaitingServerConfig,
  );
  // A failed import waits in a modal alert, and a cancel finishes its undo even
  // after the route leaves, so neither holds the route: the cancel can leave as
  // soon as it is done.
  const isIncomingShareHoldingRoute =
    isIncomingShareTransferPending &&
    shareImportPhase !== "failed" &&
    shareImportPhase !== "cancelling";
  const contextImports = useAtomValue(composerContextImportsAtom);
  const isImportingContext = flow.draftKey ? contextImports[flow.draftKey] === true : false;
  const isComposerInteractionLocked =
    isIncomingShareTransferPending || flow.submitting || isImportingContext;
  const { environments, selectedEnvironmentId, switchEnvironment, switchingToEnvironmentId } = flow;
  const cycleEnvironment = () => {
    if (isComposerInteractionLocked) return true;
    const next = nextEnvironmentId(environments, switchingToEnvironmentId ?? selectedEnvironmentId);
    if (next !== null) void switchEnvironment(next);
    return true;
  };
  const cycleEnvironmentCommands = environments.length > 1 ? (["cycleHost"] as const) : [];
  useHardwareKeyboardCommand(cycleEnvironmentCommands, cycleEnvironment);
  const composerWorkspaceCwd =
    (flow.workspaceMode === "worktree"
      ? selectedProject?.workspaceRoot
      : (flow.selectedWorktreePath ?? selectedProject?.workspaceRoot)) || null;
  const preventRemove =
    (isIncomingShareHoldingRoute && !isProjectPickerReturnActive) || flow.submitting;
  usePreventRemove(preventRemove, () => undefined);
  const isIncomingShareReady =
    !props.incomingShareId ||
    (hasImportedIncomingShare && !incomingShare) ||
    isIncomingShareUnavailable;
  const appliedInitialProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (isReturningToProjectPicker && requestedInitialProjectAvailable) {
      // oxlint-disable-next-line react/set-state-in-effect -- Ends the return-to-picker flow once the requested project arrives from the catalog.
      setIsReturningToProjectPicker(false);
    }
    if (!isProjectPickerReturnActive) {
      return;
    }
    // Wait for usePreventRemove to disable before replacing, or the transfer guard swallows the fallback.
    const frame = requestAnimationFrame(() => {
      navigation.dispatch(
        StackActions.replace("NewTaskProject", { incomingShareId: props.incomingShareId }),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [
    isProjectPickerReturnActive,
    isReturningToProjectPicker,
    navigation,
    props.incomingShareId,
    requestedInitialProjectAvailable,
  ]);

  const lastInitialProjectRefRef = useRef(props.initialProjectRef);
  const initialPickerRef = useRef<"open" | "dismissed" | null>(null);

  useEffect(() => {
    if (props.draftId) {
      return;
    }
    if (lastInitialProjectRefRef.current !== props.initialProjectRef) {
      lastInitialProjectRefRef.current = props.initialProjectRef;
      appliedInitialProjectKeyRef.current = null;
    }
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    if (initialEnvironmentId && initialProjectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === initialEnvironmentId && project.id === initialProjectId,
        ) ?? null;

      if (directProject) {
        // Apply the route project once or picker changes would immediately revert.
        const directProjectKey = `${directProject.environmentId}:${directProject.id}`;
        if (appliedInitialProjectKeyRef.current === directProjectKey) {
          return;
        }
        if (props.initialProjectRef?.branch) {
          if (
            selectedProject?.environmentId !== directProject.environmentId ||
            selectedProject.id !== directProject.id
          ) {
            setProject(directProject);
            return;
          }
          if (!flow.draftKey) return;
          // Checkout completed before mount; local mode reuses it while worktree mode would create another.
          updateComposerDraftSettings(flow.draftKey, {
            workspaceSelection: {
              mode: "local",
              branch: props.initialProjectRef.branch,
              worktreePath: props.initialProjectRef.worktreePath ?? null,
              startFromOrigin: false,
            },
          });
        }
        appliedInitialProjectKeyRef.current = directProjectKey;
        if (
          selectedProject?.environmentId === directProject.environmentId &&
          selectedProject.id === directProject.id
        ) {
          return;
        }
        setProject(directProject);
        return;
      }

      if (projects.length > 0) {
        // oxlint-disable-next-line react/set-state-in-effect -- Route-driven project resolution starts the return-to-picker flow when no project matches.
        setIsReturningToProjectPicker(true);
      }
      return;
    }

    const selection = resolveDraftProjectSelection(selectedProjectKey, projects, projectScopes, {
      incomingShareId: props.incomingShareId,
      pickerClosed: initialPickerRef.current === "open" && isFocused,
    });
    if (selection.kind === "preserve") {
      initialPickerRef.current = null;
      return;
    }
    if (selection.kind === "select") {
      setProject(selection.project);
      return;
    }
    if (selection.kind === "dismiss") {
      initialPickerRef.current = "dismissed";
      goBack();
      return;
    }
    // Open the first picker once; catalog updates must not push it again over a cancelled draft.
    if (initialPickerRef.current !== null) {
      return;
    }
    initialPickerRef.current = "open";
    navigation.dispatch(CommonActions.navigate("NewTaskProject"));
  }, [
    goBack,
    isFocused,
    projectScopes,
    projects,
    flow.draftKey,
    props.initialProjectRef,
    props.incomingShareId,
    props.draftId,
    navigation,
    selectedProject,
    selectedProjectKey,
    setProject,
  ]);

  const { loadBranches } = flow;
  useEffect(() => {
    if (!selectedProject) {
      loadedBranchesProjectKeyRef.current = null;
      return;
    }
    const projectKey = `${selectedProject.environmentId}:${selectedProject.id}`;
    if (loadedBranchesProjectKeyRef.current === projectKey) {
      return;
    }
    loadedBranchesProjectKeyRef.current = projectKey;
    loadBranches();
  }, [loadBranches, selectedProject]);

  const selectedEnvironmentLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ?? "Environment";
  const availableCurrentBranchName =
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const selectedBranchName = resolveProjectThreadCreationBranch({
    workspaceMode: flow.workspaceMode,
    selectedBranch:
      flow.selectedBranchName ??
      (flow.workspaceMode === "worktree" ? availableCurrentBranchName : null),
    currentCheckoutBranch: flow.currentCheckoutBranchName,
  });
  const selectedBranchLabel = resolveNewTaskBranchLabel({
    branchName: selectedBranchName,
    startFromOrigin: flow.startFromOrigin,
    workspaceMode: flow.workspaceMode,
    pullRequestReference: flow.pullRequestReference,
  });
  const workspaceLabel = resolveNewTaskWorkspaceLabel({
    workspaceMode: flow.workspaceMode,
    worktreePath: flow.selectedWorktreePath,
  });
  const showBranchLoading =
    environmentConnected && flow.branchesLoading && flow.availableBranches.length === 0;

  const {
    onPickDraftMedia: handlePickMedia,
    onPickDraftFiles: handlePickFiles,
    onNativePasteImages: handleNativePasteImages,
    onNativePasteText: handleNativePasteText,
  } = useComposerAttachmentActions({
    draftKey: flow.draftKey,
    serverConfig: selectedEnvironmentServerConfig,
    locked: isComposerInteractionLocked,
  });

  async function handleStart(): Promise<import("@t3tools/contracts").MessageId | null> {
    const selectedProject = flow.selectedProject;
    const draftKey = flow.draftKey;
    if (
      !selectedProject ||
      !draftKey ||
      cloneBlocksStart ||
      !isIncomingShareReady ||
      isImportingShare ||
      isComposerInteractionLocked
    ) {
      return null;
    }
    if (
      environmentConnected &&
      !readEnvironmentScope(selectedProject.environmentId, AuthOrchestrationOperateScope)
    ) {
      return null;
    }
    const draft = getComposerDraftSnapshot(draftKey);
    if (appAtomRegistry.get(composerContextImportsAtom)[draftKey]) return null;
    const modelSelection =
      resolveSelectableModelSelection(
        selectedEnvironmentServerConfig,
        draft.modelSelection ?? null,
        selectedProject.id,
      ) ?? flow.selectedModel;
    const workspaceSelection = flow.resolveWorkspaceSelection(draft.workspaceSelection);
    const workspaceMode = workspaceSelection.mode;
    const selectedBranchName = workspaceSelection.branch;
    const initialMessageText = draft.text.trim();

    if (
      attachmentBlockReason !== null ||
      !modelSelection ||
      (initialMessageText.length === 0 && draft.attachments.length === 0) ||
      flow.submitting ||
      (workspaceMode === "worktree" && !selectedBranchName)
    ) {
      return null;
    }
    if (
      environmentConnected &&
      isModelSelectionUnavailable(
        selectedEnvironmentServerConfig,
        modelSelection,
        selectedProject.id,
      )
    ) {
      const { title, detail } = describeUnavailableModelSelection(
        selectedEnvironmentServerConfig,
        modelSelection,
        selectedProject.id,
      );
      Dialog.alert(title, detail);
      return null;
    }
    // Recovery may retain over-cap attachments; block send before uploading a turn the server would reject.
    if (draft.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Dialog.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }

    const contextBlockReason = composerContextSendBlockReason(draft.context);
    if (contextBlockReason) {
      Dialog.alert("Too much context", contextBlockReason);
      return null;
    }
    const strandedThread = threadContextsOutsideEnvironment({
      text: draft.text,
      records: draft.context?.records ?? [],
      environmentId: selectedProject.environmentId,
    })[0];
    if (strandedThread) {
      const owner =
        flow.environments.find(
          (environment) => environment.environmentId === strandedThread.environmentId,
        )?.environmentLabel ?? "its machine";
      Dialog.alert(
        "Attached thread unavailable",
        `"${strandedThread.title}" is on another machine. Switch back to ${owner} or remove it from the draft.`,
      );
      return null;
    }

    const message = flow.buildPendingTaskMessage(creationMetadata, {
      currentCheckoutBranch: queuesInsteadOfStarting ? null : flow.currentCheckoutBranchName,
    });
    if (!message) {
      return null;
    }
    // Persist locally before clearing or leaving the draft; server setup runs on the thread.
    flow.setSubmitting(true);
    const queued = await settlePromise(() => enqueueThreadOutboxMessage(message));
    flow.setSubmitting(false);
    if (AsyncResult.isFailure(queued)) {
      const error = squashAtomCommandFailure(queued);
      Dialog.alert(
        "Could not queue task",
        error instanceof Error ? error.message : "The task could not be saved to the outbox.",
      );
      return null;
    }
    promptInputRef.current?.blur();
    navigation.dispatch(
      CommonActions.setParams(
        submittedThreadParams(String(message.environmentId), String(message.threadId)),
      ),
    );
    // The composer has moved to the submitted thread; a pick still converting
    // would otherwise resurrect this draft.
    abortComposerDraftOperations(draftKey);
    const draftSnapshot = getComposerDraftSnapshot(draftKey);
    // The queued message owns the attachments now, so the sweep is deferred
    // until the write confirms it.
    clearComposerDraftContent(draftKey, {
      clearModelSelection: true,
      clearWorkspaceSelection: true,
      deferAttachmentCleanup: true,
    });
    scheduleUnusedComposerAttachmentCleanup(draftSnapshot.attachments);
    return message.messageId;
  }

  // Keep the current surface until the local draft selection is ready. Publishing
  // an empty loading surface here flashes between two already-cached threads.
  if (!selectedProject) return null;

  const setupBlockReason =
    isIncomingShareReady && !isImportingShare
      ? cloneBlocksStart
        ? "Wait for the project clone to finish."
        : flow.submitting
          ? "Starting the thread…"
          : flow.workspaceMode === "worktree" && (!flow.selectedBranchName || !flow.isGitRepoKnown)
            ? "Choose a base branch before creating a worktree."
            : null
      : "Wait for shared content to finish importing.";
  const chooseProject = () => {
    if (isComposerInteractionLocked) {
      return;
    }
    promptInputRef.current?.blur();
    void KeyboardController.dismiss({ animated: true });
    navigation.navigate("NewTaskProject", { incomingShareId: props.incomingShareId });
  };
  const openContextPicker = (routeName: "NewTaskBranch" | "NewTaskEnvironment") => {
    if (isComposerInteractionLocked) {
      return;
    }
    promptInputRef.current?.blur();
    void KeyboardController.dismiss({ animated: true });
    navigation.navigate(routeName);
  };

  const environmentControl = (
    <DraftEnvironmentControl
      connectionState={connectionState}
      label={selectedEnvironmentLabel}
      machineKind={resolveEnvironmentMachineKind(selectedEnvironmentServerConfig)}
      disabled={isComposerInteractionLocked}
      onChooseEnvironment={() => openContextPicker("NewTaskEnvironment")}
    />
  );
  const shareUnavailableNotice = isIncomingShareUnavailable ? (
    <Text textRole="footnote" className="text-center text-foreground-muted">
      The shared content is no longer in the inbox. You can continue editing this task draft.
    </Text>
  ) : null;
  const hero = flow.isScratchDraft ? (
    <View className="items-center gap-2 px-6" testID="new-task-hero">
      <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
        What should we work on?
      </Text>
      <View className="flex-row flex-wrap items-center justify-center gap-x-1">
        <ComposerInlineControl
          accessibilityHint="Opens the project picker"
          accessibilityLabel="No project"
          chevronDirection="right"
          disabled={isComposerInteractionLocked}
          icon="folder"
          label="No project"
          onPress={chooseProject}
        />
        {environmentControl}
      </View>
      {shareUnavailableNotice}
    </View>
  ) : (
    <View className="items-center gap-6 px-6" testID="new-task-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we build
        </Text>
        <View className="max-w-full flex-row items-center justify-center">
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">in </Text>
          <Pressable
            accessibilityHint="Opens the project picker"
            accessibilityLabel={selectedProjectLabel ?? selectedProject.title}
            accessibilityRole="button"
            disabled={isComposerInteractionLocked}
            onPress={chooseProject}
            className="min-w-0 max-w-[250px] border-b border-foreground-muted active:opacity-65"
          >
            <Text
              className="text-2xl font-t3-medium tracking-tight text-foreground"
              numberOfLines={1}
            >
              {selectedProjectLabel ?? selectedProject.title}
            </Text>
          </Pressable>
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">?</Text>
        </View>
      </View>

      {environmentControl}
      {shareUnavailableNotice}
    </View>
  );
  // The nested hero scroll view does not receive UIKit's automatic navigation inset in split columns.
  const heroViewport = (headerInset: number, bottomInset: number, availableHeight: number) =>
    availableHeight < 180 ? null : (
      <NativeScrollEdgeEffectsContext
        value={{ top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" }}
      >
        <View
          collapsable={false}
          style={{
            position: "absolute",
            top: headerInset,
            bottom: bottomInset,
            left: 0,
            right: 0,
            overflow: "hidden",
          }}
        >
          <ScrollView
            alwaysBounceVertical={false}
            className="flex-1"
            contentInsetAdjustmentBehavior="never"
            contentContainerClassName="grow items-center"
            contentContainerStyle={{ paddingVertical: 24 }}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            testID="new-task-hero-scroll"
          >
            <View style={{ flexGrow: 1 }} />
            {hero}
            <View style={{ flexGrow: 2 }} />
          </ScrollView>
        </View>
      </NativeScrollEdgeEffectsContext>
    );

  const workspaceControls = (
    <View className="flex-row items-center gap-1 px-2">
      <ComposerInlineControl
        accessibilityHint={`Switches to ${flow.workspaceMode === "local" ? "a new worktree" : "the current checkout"}`}
        accessibilityLabel={workspaceLabel}
        disabled={isComposerInteractionLocked || !flow.isGitRepo}
        renderIcon={(size) => (
          <NewTaskWorkspaceIcon
            workspaceMode={flow.workspaceMode}
            worktreePath={flow.selectedWorktreePath}
            size={size}
          />
        )}
        label={workspaceLabel}
        maxWidth="100%"
        onPress={() => flow.setWorkspaceMode(flow.workspaceMode === "local" ? "worktree" : "local")}
        showChevron={false}
      />

      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityLabel={`${flow.workspaceMode === "worktree" ? "Base branch" : "Branch"}: ${selectedBranchLabel}`}
          chevronDirection="right"
          disabled={isComposerInteractionLocked || !flow.isGitRepo}
          icon="arrow.triangle.branch"
          label={showBranchLoading ? "Loading branches…" : selectedBranchLabel}
          maxWidth="100%"
          onPress={() => openContextPicker("NewTaskBranch")}
        />
      </View>
    </View>
  );

  if (!flow.selectedModel) {
    return (
      <ThreadScreenFallback
        header={
          <AppBar
            title="New thread"
            sidebar={false}
            onBack={goBack}
            options={{
              ...threadHeaderAppearance(NATIVE_LIQUID_GLASS_SUPPORTED),
              unstable_headerSubtitle: undefined,
              unstable_headerRightItems: () => [],
              unstable_headerToolbarItems: () => [],
            }}
          />
        }
      >
        <View className="flex-1 justify-end gap-3 p-4">
          {environmentControl}
          <Text className="text-foreground-muted">
            Your draft is saved on this device. Connect to an environment to choose its first model.
          </Text>
          <ComposerEditor
            draftKey={flow.draftKey}
            value={flow.prompt}
            onChangeText={flow.setPrompt}
            placeholder="Ask anything"
            multiline
            style={{ minHeight: 64 }}
          />
        </View>
      </ThreadScreenFallback>
    );
  }
  const thread = draftThreadShell({
    environmentId: selectedProject.environmentId,
    projectId: selectedProject.id,
    threadId: ThreadId.make(creationMetadata.threadId),
    modelSelection: flow.selectedModel,
    runtimeMode: flow.runtimeMode,
    interactionMode: flow.interactionMode,
    branch: flow.selectedBranchName,
    worktreePath: flow.selectedWorktreePath,
    createdAt: creationMetadata.createdAt,
  });
  return (
    <>
      <ThreadScreenBinding
        environmentId={selectedProject.environmentId}
        header={
          <DraftThreadHeader thread={thread} project={selectedProject} cwd={composerWorkspaceCwd} />
        }
        draftMode={{
          content: heroViewport,
          controls: (
            <View className="pb-1">
              {projectClone && projectClone.phase !== "done" && selectedProject ? (
                <View className="px-1 pb-2">
                  <ProjectCloneBanner
                    clone={projectClone}
                    onCancel={() =>
                      void runCloneAction("Failed to cancel clone", () =>
                        cancelProjectClone({
                          environmentId: selectedProject.environmentId,
                          input: { projectId: selectedProject.id },
                        }),
                      )
                    }
                    onRetry={() =>
                      void runCloneAction("Failed to retry clone", () =>
                        retryProjectClone({
                          environmentId: selectedProject.environmentId,
                          input: { projectId: selectedProject.id },
                        }),
                      )
                    }
                    onRemove={() => void removeClonedProject()}
                  />
                </View>
              ) : null}
              {flow.canChooseWorkspace ? workspaceControls : null}
            </View>
          ),
          editorRef: promptInputRef,
          sendBlockedReason: setupBlockReason,
          interactionLocked: isComposerInteractionLocked,
        }}
        canOperateThread={canOperate}
        selectedThread={thread}
        selectedThreadDetailRef={null}
        contentPresentation={{ kind: "ready" }}
        screenTone={connectionTone(connectionState)}
        connectionError={environmentRuntime?.connectionError ?? null}
        environmentLabel={selectedEnvironmentLabel}
        feedbackSubmissions={[]}
        onDismissFeedback={() => {}}
        selectedThreadFeed={[]}
        activityRun={null}
        activeWorkStartedAt={null}
        isCompacting={false}
        creationState={null}
        activePendingApproval={null}
        activePendingApprovals={[]}
        respondingApprovalId={null}
        activePendingUserInput={null}
        activePendingUserInputDrafts={{}}
        activePendingUserInputAnswers={null}
        respondingUserInputId={null}
        connectionStateLabel={connectionState}
        activeThreadBusy={false}
        canStopThread={false}
        queuedRunEdit={null}
        composerDraftKey={flow.draftKey}
        followUpBehavior="queue"
        canSteerActiveTurn={false}
        isSavingQueuedEdit={false}
        onCancelQueuedRunEdit={() => {}}
        onRemoveQueuedEditAttachment={() => {}}
        projectWorkspaceRoot={selectedProject.workspaceRoot}
        threadCwd={composerWorkspaceCwd}
        selectedThreadQueueCount={0}
        queuedMessages={[]}
        dispatchingMessageId={null}
        serverConfig={selectedEnvironmentServerConfig}
        usesAutomaticContentInsets
        onOpenConnectionEditor={() => navigation.navigate("Connections")}
        onChangeDraftMessage={flow.setPrompt}
        onPickDraftMedia={handlePickMedia}
        onPickDraftFiles={handlePickFiles}
        onNativePasteImages={handleNativePasteImages}
        onNativePasteText={handleNativePasteText}
        onRemoveDraftImage={flow.removeAttachment}
        onStopThread={() => {}}
        onResumeQueue={null}
        onSendMessage={handleStart}
        onReconnectEnvironment={() => onReconnectEnvironment(selectedProject.environmentId)}
        canSwitchThreadProvider
        onUpdateThreadInteractionMode={flow.planModeEnabled ? flow.setInteractionMode : undefined}
        onRespondToApproval={async () => {}}
        onSelectUserInputOption={() => {}}
        onChangeUserInputCustomAnswer={() => {}}
        onSubmitUserInput={async () => {}}
        onDismissUserInput={async () => {}}
      />
    </>
  );
}
