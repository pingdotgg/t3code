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
  useNavigation,
  usePreventRemove,
} from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
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
  mergeComposerDraftContent,
  restoreComposerDraftSnapshot,
  updateComposerDraftSettings,
  scheduleUnusedComposerAttachmentCleanup,
  type ComposerDraft,
  waitForComposerDraftsLoaded,
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
  resolveNewTaskWorkspaceSelection,
} from "./new-task-context-presentation";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { selectIncomingShareAttachmentsForServer } from "../sharing/incoming-share-model";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

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
  readonly pendingTaskId?: string;
  readonly draftId?: string;
  readonly incomingShareId?: string;
}) {
  const [creationMetadata] = useState(makeTurnCommandMetadata);
  const projects = useProjects();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const goBack = useWorkspaceBackNavigation("threads");
  const {
    consumeShare,
    getShare,
    isLoading: isIncomingShareInboxLoading,
    releaseShareReservation,
    reserveShare,
  } = useIncomingShare();
  const { projectScopes, selectedProject, selectedProjectKey, setProject } = flow;
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
  const selectedProjectRef = useRef(selectedProject);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);
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
    const current = selectedProjectRef.current;
    if (current?.id === removed.id && current.environmentId === removed.environmentId) {
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
  const [importingShareKey, setImportingShareKey] = useState<string | null>(null);
  const [isCancellingShareImport, setIsCancellingShareImport] = useState(false);
  const [cancelledIncomingShareId, setCancelledIncomingShareId] = useState<string | null>(null);
  const [isReturningToProjectPicker, setIsReturningToProjectPicker] = useState(false);
  const [shareImportAttempt, setShareImportAttempt] = useState(0);
  const startedShareImportKeyRef = useRef<string | null>(null);
  const cancellingShareImportKeyRef = useRef<string | null>(null);
  const shareImportDraftBackupRef = useRef(new Map<string, ComposerDraft>());
  const activeShareImportTokenRef = useRef<symbol | null>(null);
  const shareImportMountedRef = useRef(true);
  // The share import resumes after awaits; this reads the screen's current
  // draft and share at that point without re-running the import effect.
  const isCurrentShareImport = useEffectEvent(
    (draftKey: string, shareId: string) =>
      flow.draftKey === draftKey && props.incomingShareId === shareId,
  );
  const isImportingShare = importingShareKey !== null;
  const alertedUnavailableIncomingShareIdRef = useRef<string | null>(null);
  // Remember consumed shares locally: send clears the receipt before navigation and can trigger a missing-content render.
  const [consumedIncomingShareId, setConsumedIncomingShareId] = useState<string | null>(null);
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
  const isProjectPickerReturnActive =
    isReturningToProjectPicker && !requestedInitialProjectAvailable;
  const isIncomingShareAwaitingServerConfig = Boolean(
    incomingShare?.attachments.some((attachment) => attachment.type === "file") &&
    selectedEnvironmentServerConfig === null,
  );
  const isIncomingShareTransferPending = Boolean(
    incomingShare &&
    cancelledIncomingShareId !== props.incomingShareId &&
    !isIncomingShareAwaitingServerConfig,
  );
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
    (isIncomingShareTransferPending && !isProjectPickerReturnActive) ||
    isCancellingShareImport ||
    flow.submitting;
  usePreventRemove(preventRemove, () => undefined);
  const hasImportedIncomingShare = Boolean(
    props.incomingShareId &&
    (consumedIncomingShareId === props.incomingShareId ||
      (flow.draftKey &&
        getComposerDraftSnapshot(flow.draftKey).importedShareIds?.includes(props.incomingShareId))),
  );
  const isIncomingShareUnavailable = Boolean(
    props.incomingShareId &&
    !isIncomingShareInboxLoading &&
    !incomingShare &&
    !hasImportedIncomingShare,
  );
  const isIncomingShareReady =
    !props.incomingShareId ||
    (hasImportedIncomingShare && !incomingShare) ||
    isIncomingShareUnavailable;
  const appliedInitialProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (cancelledIncomingShareId === props.incomingShareId) {
      navigation.goBack();
    }
  }, [cancelledIncomingShareId, navigation, props.incomingShareId]);
  useEffect(() => {
    if (!isReturningToProjectPicker) {
      return;
    }
    if (requestedInitialProjectAvailable) {
      // oxlint-disable-next-line react/set-state-in-effect -- Ends the return-to-picker flow once the requested project arrives from the catalog.
      setIsReturningToProjectPicker(false);
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
    isReturningToProjectPicker,
    navigation,
    props.incomingShareId,
    requestedInitialProjectAvailable,
  ]);
  useEffect(() => {
    if (!shareImportMountedRef.current) {
      startedShareImportKeyRef.current = null;
    }
    shareImportMountedRef.current = true;
    return () => {
      appliedInitialProjectKeyRef.current = null;
      shareImportMountedRef.current = false;
      activeShareImportTokenRef.current = null;
      cancellingShareImportKeyRef.current = null;
    };
  }, []);

  const { beginEditingPendingTask, cancelEditingPendingTask, editingPendingTask, openDraft } = flow;
  // Cold launches load drafts and projects separately; wait for hydration and retry while shells load.
  const attemptedDraftIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.draftId || props.pendingTaskId) {
      return;
    }
    const draftId = props.draftId;
    if (attemptedDraftIdRef.current === draftId) {
      return;
    }
    let cancelled = false;
    void waitForComposerDraftsLoaded().then(() => {
      if (cancelled || attemptedDraftIdRef.current === draftId) {
        return;
      }
      if (openDraft(draftId)) {
        attemptedDraftIdRef.current = draftId;
        return;
      }
      if (getComposerDraftSnapshot(draftId).project !== undefined && projects.length === 0) {
        return;
      }
      attemptedDraftIdRef.current = draftId;
      navigation.dispatch(CommonActions.navigate("NewTaskProject"));
    });
    return () => {
      cancelled = true;
    };
  }, [navigation, openDraft, projects, props.draftId, props.pendingTaskId]);

  const attemptedPendingTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.pendingTaskId || editingPendingTask?.messageId === props.pendingTaskId) {
      return;
    }
    if (attemptedPendingTaskIdRef.current === props.pendingTaskId) {
      return;
    }
    attemptedPendingTaskIdRef.current = props.pendingTaskId;
    if (!beginEditingPendingTask(props.pendingTaskId)) {
      navigation.dispatch(CommonActions.navigate("NewTaskProject"));
    }
  }, [beginEditingPendingTask, editingPendingTask?.messageId, navigation, props.pendingTaskId]);

  useEffect(() => {
    if (!props.pendingTaskId) return;
    return () => {
      attemptedPendingTaskIdRef.current = null;
      cancelEditingPendingTask();
    };
  }, [props.pendingTaskId, cancelEditingPendingTask]);

  const lastInitialProjectRefRef = useRef(props.initialProjectRef);

  useEffect(() => {
    if (props.pendingTaskId || props.draftId) {
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

    const selection = resolveDraftProjectSelection(selectedProjectKey, projects, projectScopes);
    if (selection.kind === "preserve") {
      return;
    }
    if (selection.kind === "select") {
      setProject(selection.project);
      return;
    }

    navigation.dispatch(CommonActions.navigate("NewTaskProject"));
  }, [
    projectScopes,
    projects,
    flow.draftKey,
    props.initialProjectRef,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Opening a draft from a share, pending task, or draft id re-resolves its project.
    props.incomingShareId,
    props.pendingTaskId,
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

  useEffect(() => {
    const shareId = props.incomingShareId;
    const draftKey = flow.draftKey;
    const destinationProject = selectedProject;
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    const selectedProjectMatchesRoute =
      !initialEnvironmentId ||
      !initialProjectId ||
      (destinationProject?.environmentId === initialEnvironmentId &&
        destinationProject.id === initialProjectId);
    if (
      !shareId ||
      !draftKey ||
      !destinationProject ||
      !selectedProjectMatchesRoute ||
      cancelledIncomingShareId === shareId
    ) {
      return;
    }
    const importKey = `${shareId}:${draftKey}`;
    if (
      startedShareImportKeyRef.current === importKey ||
      cancellingShareImportKeyRef.current === importKey
    ) {
      return;
    }

    if (!incomingShare) {
      if (isIncomingShareUnavailable && alertedUnavailableIncomingShareIdRef.current !== shareId) {
        alertedUnavailableIncomingShareIdRef.current = shareId;
        Dialog.alert(
          "Shared content unavailable",
          "The shared content is no longer in the inbox. You can continue editing this task draft.",
        );
      }
      return;
    }

    if (
      incomingShare.attachments.some((attachment) => attachment.type === "file") &&
      selectedEnvironmentServerConfig === null
    ) {
      return;
    }

    if (alertedUnavailableIncomingShareIdRef.current === shareId) {
      alertedUnavailableIncomingShareIdRef.current = null;
    }
    startedShareImportKeyRef.current = importKey;
    const draftBackup =
      shareImportDraftBackupRef.current.get(importKey) ?? getComposerDraftSnapshot(draftKey);
    shareImportDraftBackupRef.current.set(importKey, draftBackup);
    const importToken = Symbol(importKey);
    let didReserveShare = false;
    let didConsumeShare = false;
    let needsDraftRestore = false;
    activeShareImportTokenRef.current = importToken;
    // oxlint-disable-next-line react/set-state-in-effect -- Publishes the share import started by this effect before its async work runs.
    setImportingShareKey(importKey);
    void (async () => {
      await reserveShare(shareId, {
        environmentId: String(destinationProject.environmentId),
        projectId: String(destinationProject.id),
      });
      didReserveShare = true;
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        !isCurrentShareImport(draftKey, shareId)
      ) {
        return;
      }
      const selectedAttachments = selectIncomingShareAttachmentsForServer({
        attachments: incomingShare.attachments,
        serverConfig: appAtomRegistry.get(
          serverEnvironment.configValueAtom(destinationProject.environmentId),
        ),
      });
      if (selectedAttachments.status === "pending") {
        throw new Error("Server attachment support is still loading.");
      }
      needsDraftRestore = true;
      const { skippedAttachmentCount } = await mergeComposerDraftContent(draftKey, {
        text: incomingShare.text,
        attachments: selectedAttachments.attachments,
        sourceShareId: shareId,
      });
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        !isCurrentShareImport(draftKey, shareId)
      ) {
        // Durable reservations resume interrupted transfers only in this project, avoiding duplicate draft copies.
        return;
      }
      await consumeShare(shareId);
      didConsumeShare = true;
      setConsumedIncomingShareId(shareId);
      // Release skipped files after consumption even on unmount; sweeping re-checks new owners.
      const retainedAttachmentIds = new Set(
        getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
      );
      scheduleUnusedComposerAttachmentCleanup(
        incomingShare.attachments.filter((attachment) => !retainedAttachmentIds.has(attachment.id)),
      );
      if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
        return;
      }
      const warnings = [...incomingShare.warnings, ...selectedAttachments.warnings];
      if (skippedAttachmentCount > 0) {
        warnings.push(
          `${skippedAttachmentCount} shared file${skippedAttachmentCount === 1 ? " was" : "s were"} skipped because this draft reached the attachment limit.`,
        );
      }
      if (warnings.length > 0) {
        Dialog.alert("Some shared content was skipped", warnings.join("\n"));
      }
      shareImportDraftBackupRef.current.delete(importKey);
    })()
      .catch((error) => {
        if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
          return;
        }
        Dialog.alert(
          "Could not import shared content",
          error instanceof Error ? error.message : "The shared content could not be saved.",
          [
            {
              text: "Cancel import",
              style: "cancel",
              onPress: () => {
                const cancelImport = async (): Promise<void> => {
                  if (!shareImportMountedRef.current) {
                    return;
                  }
                  // Latch before restoring: atom publication can re-run import before React commits cancellation.
                  cancellingShareImportKeyRef.current = importKey;
                  setIsCancellingShareImport(true);
                  try {
                    if (needsDraftRestore) {
                      // Sweep restored attachments only after inbox consumption; unconsumed inbox entries still own them.
                      const mergedAttachments = getComposerDraftSnapshot(draftKey).attachments;
                      await restoreComposerDraftSnapshot(draftKey, draftBackup);
                      needsDraftRestore = false;
                      if (didConsumeShare) {
                        scheduleUnusedComposerAttachmentCleanup(mergedAttachments);
                      }
                    }
                    if (didReserveShare) {
                      await releaseShareReservation(shareId, {
                        environmentId: String(destinationProject.environmentId),
                        projectId: String(destinationProject.id),
                      });
                    }
                    shareImportDraftBackupRef.current.delete(importKey);
                    if (shareImportMountedRef.current) {
                      setIsCancellingShareImport(false);
                      setCancelledIncomingShareId(shareId);
                    }
                  } catch (cancelError) {
                    if (!shareImportMountedRef.current) {
                      return;
                    }
                    Dialog.alert(
                      "Could not cancel import",
                      cancelError instanceof Error
                        ? cancelError.message
                        : "The shared content could not be restored safely.",
                      [
                        {
                          text: "Retry import",
                          onPress: () => {
                            cancellingShareImportKeyRef.current = null;
                            setIsCancellingShareImport(false);
                            setShareImportAttempt((attempt) => attempt + 1);
                          },
                        },
                        {
                          text: "Retry cancel",
                          onPress: () => void cancelImport(),
                        },
                      ],
                      { cancelable: false },
                    );
                  }
                };
                void cancelImport();
              },
            },
            {
              text: "Retry",
              onPress: () => setShareImportAttempt((attempt) => attempt + 1),
            },
          ],
          { cancelable: false },
        );
      })
      .finally(() => {
        if (startedShareImportKeyRef.current === importKey) {
          startedShareImportKeyRef.current = null;
        }
        if (shareImportMountedRef.current && activeShareImportTokenRef.current === importToken) {
          activeShareImportTokenRef.current = null;
          setImportingShareKey(null);
        }
      });
  }, [
    consumeShare,
    cancelledIncomingShareId,
    flow.draftKey,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- hasImportedIncomingShare reflects the draft store; a change re-checks whether the share still needs importing.
    hasImportedIncomingShare,
    incomingShare,
    isIncomingShareInboxLoading,
    isIncomingShareUnavailable,
    props.incomingShareId,
    props.initialProjectRef?.environmentId,
    props.initialProjectRef?.projectId,
    releaseShareReservation,
    reserveShare,
    selectedEnvironmentServerConfig,
    selectedProject,
    shareImportAttempt,
  ]);

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
    const workspaceSelection = resolveNewTaskWorkspaceSelection({
      selection: draft.workspaceSelection,
      fallback: {
        mode: flow.workspaceMode,
        branch: flow.selectedBranchName,
        worktreePath: flow.selectedWorktreePath,
      },
      isGitRepo: flow.isGitRepo,
    });
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

    const editingPendingTask = flow.editingPendingTask;

    const metadata = editingPendingTask
      ? {
          threadId: editingPendingTask.threadId,
          commandId: editingPendingTask.commandId,
          messageId: editingPendingTask.messageId,
          createdAt: editingPendingTask.createdAt,
        }
      : creationMetadata;
    const message = flow.buildPendingTaskMessage(metadata, {
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
    if (editingPendingTask) {
      flow.finishEditingPendingTask();
    } else {
      // The queued message owns the attachments now, so the sweep is deferred
      // until the write confirms it.
      clearComposerDraftContent(draftKey, {
        clearModelSelection: true,
        clearWorkspaceSelection: true,
        deferAttachmentCleanup: true,
      });
    }
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
      <ThreadScreenFallback>
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
    threadId: ThreadId.make(flow.editingPendingTask?.threadId ?? creationMetadata.threadId),
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
