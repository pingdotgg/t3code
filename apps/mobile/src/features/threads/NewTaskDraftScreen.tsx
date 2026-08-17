import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  usePreventRemove,
} from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useFontFamily } from "../../lib/useFontFamily";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";

import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerInlineControl,
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ComposerSurface } from "./ThreadComposer";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  restoreComposerDraftSnapshot,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { buildModelMenuActions, resolveSelectableModelSelection } from "../../lib/modelOptions";
import { deriveThreadTitleFromPrompt } from "../../lib/projectThreadStartTurn";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { enqueueThreadOutboxMessage, removeThreadOutboxMessage } from "../../state/thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";
import { useCreateProjectThread } from "./use-project-actions";
import { resolveDraftProjectSelection } from "./new-task-project-selection";
import {
  resolveNewTaskBranchLabel,
  resolveNewTaskWorkspaceLabel,
} from "./new-task-context-presentation";
import { useIncomingShare } from "../sharing/IncomingShareProvider";

function NewTaskWorkspaceIcon(props: {
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
}) {
  const iconColor = useThemeColor("--color-icon-muted");

  if (props.workspaceMode === "local" && props.worktreePath === null) {
    return <SymbolView name="folder" size={16} tintColor={iconColor} type="monochrome" />;
  }

  return (
    <View className="size-4">
      <SymbolView name="folder" size={16} tintColor={iconColor} type="monochrome" />
      <View className="absolute -right-1 -bottom-1">
        <SymbolView name="arrow.triangle.branch" size={9} tintColor={iconColor} type="monochrome" />
      </View>
    </View>
  );
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
  /** Queued outbox message id when editing an existing pending task. */
  readonly pendingTaskId?: string;
  /** Durable native share inbox item to merge into this project draft. */
  readonly incomingShareId?: string;
}) {
  const projects = useProjects();
  const createProjectThread = useCreateProjectThread();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const {
    consumeShare,
    getShare,
    isLoading: isIncomingShareInboxLoading,
    releaseShareReservation,
    reserveShare,
  } = useIncomingShare();
  const insets = useSafeAreaInsets();
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = Math.max(insets.bottom, 10);
  const keyboardOpenedOffset = Math.max(0, controlsBottomPadding - 8);
  const { projectScopes, selectedProject, selectedProjectKey, setProject } = flow;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const environmentConnected =
    selectedProject !== null &&
    connectedEnvironments.find(
      (environment) => environment.environmentId === selectedProject.environmentId,
    )?.connectionState === "connected";
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: promptInputRef,
    isEditorFocused: isComposerFocused,
  });
  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }

    navigation.getParent()?.setOptions({ gestureEnabled: !isKeyboardVisible });
  }, [isKeyboardVisible, navigation]);
  useEffect(() => {
    return () => {
      if (Platform.OS === "ios") {
        navigation.getParent()?.setOptions({ gestureEnabled: true });
      }
    };
  }, [navigation]);
  const settingsRoutePresentedRef = useRef(false);
  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettings"));
  }, [navigation, settingsSheetPresentation.isVisible]);
  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) {
        return;
      }

      settingsRoutePresentedRef.current = false;
      settingsSheetPresentation.onDismissed();
    }, [settingsSheetPresentation.onDismissed]),
  );
  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );
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
  const latestDraftKeyRef = useRef(flow.draftKey);
  const latestIncomingShareIdRef = useRef(props.incomingShareId);
  latestDraftKeyRef.current = flow.draftKey;
  latestIncomingShareIdRef.current = props.incomingShareId;
  const isImportingShare = importingShareKey !== null;
  const alertedUnavailableIncomingShareIdRef = useRef<string | null>(null);
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
  const isIncomingShareTransferPending = Boolean(
    incomingShare && cancelledIncomingShareId !== props.incomingShareId,
  );
  usePreventRemove(
    (isIncomingShareTransferPending && !isProjectPickerReturnActive) || isCancellingShareImport,
    () => undefined,
  );
  const hasImportedIncomingShare = Boolean(
    props.incomingShareId &&
    flow.draftKey &&
    getComposerDraftSnapshot(flow.draftKey).importedShareIds?.includes(props.incomingShareId),
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
      setIsReturningToProjectPicker(false);
      return;
    }
    // Let usePreventRemove commit its disabled state before replacing this
    // route, otherwise the transfer guard can swallow the fallback action.
    const frame = requestAnimationFrame(() => {
      navigation.dispatch(
        StackActions.replace("NewTask", { incomingShareId: props.incomingShareId }),
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

  const { beginEditingPendingTask, cancelEditingPendingTask, editingPendingTask } = flow;
  const attemptedPendingTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.pendingTaskId || editingPendingTask?.messageId === props.pendingTaskId) {
      return;
    }
    // Attempt each pending task once: after it is delivered or deleted the
    // editing session legitimately ends, and re-running must not navigate.
    if (attemptedPendingTaskIdRef.current === props.pendingTaskId) {
      return;
    }
    attemptedPendingTaskIdRef.current = props.pendingTaskId;
    if (!beginEditingPendingTask(props.pendingTaskId)) {
      // The queued task no longer exists (sent or deleted before opening).
      navigation.dispatch(StackActions.replace("NewTask"));
    }
  }, [beginEditingPendingTask, editingPendingTask?.messageId, navigation, props.pendingTaskId]);

  useEffect(() => {
    if (!props.pendingTaskId) return;
    return () => {
      // Allow a later navigation for the same pending task to re-hydrate it.
      attemptedPendingTaskIdRef.current = null;
      cancelEditingPendingTask();
    };
  }, [props.pendingTaskId, cancelEditingPendingTask]);

  const foregroundColor = useThemeColor("--color-foreground");
  const sheetColor = String(useThemeColor("--color-sheet"));
  const projectUnderlineColor = useThemeColor("--color-foreground-muted");
  const regularFontFamily = useFontFamily("regular");
  const bodyText = useScaledTextRole("body");
  const sheetFadeOpaque = sheetColor;
  const sheetFadeTransparent = themeColorWithAlpha(sheetColor, 0);

  // A new navigation to this mounted screen delivers a fresh initialProjectRef
  // reference — treat it as a new request and let it apply again.
  const lastInitialProjectRefRef = useRef(props.initialProjectRef);

  useEffect(() => {
    // Pending-task editing owns project selection (and must not fall through
    // to the replace("NewTask") fallback while its hydration is in flight).
    if (props.pendingTaskId) {
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
        // Apply the route's project once. Re-applying on every change would
        // instantly revert environment/project switches made in the picker.
        const directProjectKey = `${directProject.environmentId}:${directProject.id}`;
        if (appliedInitialProjectKeyRef.current === directProjectKey) {
          return;
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
        // Never fall through to the flow provider's temporary first-project
        // default. Return to the picker with the share id intact so the user
        // can choose an available destination.
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

    navigation.dispatch(StackActions.replace("NewTask"));
  }, [
    projectScopes,
    projects,
    props.initialProjectRef,
    props.incomingShareId,
    props.pendingTaskId,
    navigation,
    selectedProject,
    selectedProjectKey,
    setProject,
  ]);

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
    flow.loadBranches();
  }, [flow.loadBranches, selectedProject]);

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
        Alert.alert(
          "Shared content unavailable",
          "The shared content is no longer in the inbox. You can continue editing this task draft.",
        );
      }
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
    let needsDraftRestore = false;
    activeShareImportTokenRef.current = importToken;
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
        latestDraftKeyRef.current !== draftKey ||
        latestIncomingShareIdRef.current !== shareId
      ) {
        return;
      }
      needsDraftRestore = true;
      const { skippedAttachmentCount } = await mergeComposerDraftContent(draftKey, {
        text: incomingShare.text,
        attachments: incomingShare.attachments,
        sourceShareId: shareId,
      });
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        latestDraftKeyRef.current !== draftKey ||
        latestIncomingShareIdRef.current !== shareId
      ) {
        // The durable reservation makes an interrupted transfer resume only
        // in this project instead of copying into a second project draft.
        return;
      }
      await consumeShare(shareId);
      if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
        return;
      }
      const warnings = [...incomingShare.warnings];
      if (skippedAttachmentCount > 0) {
        warnings.push(
          `${skippedAttachmentCount} shared image${skippedAttachmentCount === 1 ? " was" : "s were"} skipped because this draft reached the attachment limit.`,
        );
      }
      if (warnings.length > 0) {
        Alert.alert("Some shared content was skipped", warnings.join("\n"));
      }
      shareImportDraftBackupRef.current.delete(importKey);
    })()
      .catch((error) => {
        if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
          return;
        }
        Alert.alert(
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
                  // Latch synchronously before restoring the draft. The
                  // restore publishes atom state and can re-run the import
                  // effect before React commits the cancelling state update.
                  cancellingShareImportKeyRef.current = importKey;
                  setIsCancellingShareImport(true);
                  try {
                    if (needsDraftRestore) {
                      await restoreComposerDraftSnapshot(draftKey, draftBackup);
                      needsDraftRestore = false;
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
                    Alert.alert(
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
          // Every terminal path, including an invalidated operation, must
          // release the synchronous start latch so this transfer can retry.
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
    hasImportedIncomingShare,
    incomingShare,
    isIncomingShareInboxLoading,
    isIncomingShareUnavailable,
    props.incomingShareId,
    props.initialProjectRef?.environmentId,
    props.initialProjectRef?.projectId,
    releaseShareReservation,
    reserveShare,
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
  });
  const workspaceLabel = resolveNewTaskWorkspaceLabel({
    workspaceMode: flow.workspaceMode,
    worktreePath: flow.selectedWorktreePath,
  });
  const showBranchLoading = flow.branchesLoading && flow.availableBranches.length === 0;

  async function handlePickImages(): Promise<void> {
    if (isIncomingShareTransferPending) {
      return;
    }
    const result = await pickComposerImages({ existingCount: flow.attachments.length });
    if (result.images.length > 0) {
      flow.appendAttachments(result.images);
    }
  }

  const handleNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: flow.attachments.length,
        });
        if (images.length > 0) {
          flow.appendAttachments(images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", error);
      }
    },
    [flow],
  );

  async function handleStart(): Promise<void> {
    const selectedProject = flow.selectedProject;
    const draftKey = flow.draftKey;
    if (!selectedProject || !draftKey) {
      return;
    }
    const draft = getComposerDraftSnapshot(draftKey);
    // Snapshot read keeps just-typed selector state; the availability gate
    // still applies so a stored selection on a disabled provider falls back
    // to the flow's resolved model.
    const modelSelection =
      resolveSelectableModelSelection(
        selectedEnvironmentServerConfig,
        draft.modelSelection ?? null,
      ) ?? flow.selectedModel;
    const workspaceMode = draft.workspaceSelection?.mode ?? flow.workspaceMode;
    const selectedBranchName = draft.workspaceSelection?.branch ?? flow.selectedBranchName;
    const selectedWorktreePath =
      draft.workspaceSelection?.worktreePath ?? flow.selectedWorktreePath;
    const startFromOrigin = draft.workspaceSelection?.startFromOrigin ?? flow.startFromOrigin;
    const runtimeMode = draft.runtimeMode ?? flow.runtimeMode;
    const interactionMode = flow.planModeEnabled
      ? (draft.interactionMode ?? flow.interactionMode)
      : "default";
    const initialMessageText = draft.text.trim();

    if (
      !modelSelection ||
      initialMessageText.length === 0 ||
      flow.submitting ||
      (workspaceMode === "worktree" && !selectedBranchName)
    ) {
      return;
    }

    const editingPendingTask = flow.editingPendingTask;

    if (!environmentConnected) {
      // Offline: park the task in the outbox; the drain sends it when the
      // environment reconnects. Editing an existing pending task re-queues it
      // under its original identifiers.
      const metadata = editingPendingTask
        ? {
            threadId: editingPendingTask.threadId,
            commandId: editingPendingTask.commandId,
            messageId: editingPendingTask.messageId,
            createdAt: editingPendingTask.createdAt,
          }
        : makeTurnCommandMetadata();
      const message = flow.buildPendingTaskMessage(metadata);
      if (!message) {
        return;
      }
      flow.setSubmitting(true);
      try {
        await enqueueThreadOutboxMessage(message);
      } catch (error) {
        Alert.alert(
          "Could not queue task",
          error instanceof Error ? error.message : "The task could not be saved to the outbox.",
        );
        return;
      } finally {
        flow.setSubmitting(false);
      }
      if (editingPendingTask) {
        flow.finishEditingPendingTask();
      } else {
        // Drop the workspace selection with the content: the next task should
        // re-resolve mode/branch/origin from the server's configured defaults
        // instead of resurrecting this task's picks.
        clearComposerDraftContent(draftKey, { clearWorkspaceSelection: true });
      }
      navigation.getParent()?.goBack();
      return;
    }

    flow.setSubmitting(true);
    // Arm the lock-screen card before the async thread creation: backgrounding
    // the app right after tapping submit would otherwise reject the foreground
    // -only Activity start. If creation fails, the token registration's replay
    // finds no work and ends the card within seconds.
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: selectedProject.environmentId,
      threadTitle: deriveThreadTitleSeed({
        text: initialMessageText,
        attachments: draft.attachments,
      }),
      projectTitle: selectedProject.title,
    });
    const creationBranch = resolveProjectThreadCreationBranch({
      workspaceMode,
      selectedBranch: selectedBranchName,
      currentCheckoutBranch: flow.currentCheckoutBranchName,
    });
    const result = await createProjectThread({
      project: selectedProject,
      modelSelection,
      envMode: workspaceMode,
      branch: creationBranch,
      worktreePath: workspaceMode === "worktree" ? null : selectedWorktreePath,
      startFromOrigin,
      runtimeMode,
      interactionMode,
      initialMessageText,
      initialAttachments: draft.attachments,
      ...(editingPendingTask
        ? {
            turnMetadata: {
              threadId: editingPendingTask.threadId,
              commandId: editingPendingTask.commandId,
              messageId: editingPendingTask.messageId,
              createdAt: editingPendingTask.createdAt,
            },
          }
        : {}),
    });
    flow.setSubmitting(false);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not start task",
          error instanceof Error ? error.message : "The task could not be started.",
        );
      }
      return;
    }

    if (editingPendingTask) {
      try {
        await removeThreadOutboxMessage(editingPendingTask);
      } catch (error) {
        console.warn("[new-task] failed to remove delivered pending task", error);
      }
      flow.finishEditingPendingTask();
    } else {
      clearComposerDraftContent(draftKey, { clearWorkspaceSelection: true });
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(result.value.environmentId),
        threadId: String(result.value.threadId),
      }),
    );
  }

  if (!selectedProject) {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        {Platform.OS === "android" ? (
          <>
            <NativeStackScreenOptions options={{ headerShown: false }} />
            <AndroidScreenHeader title="New Thread" onBack={() => navigation.goBack()} />
          </>
        ) : (
          <NativeStackScreenOptions options={{ title: "Loading task" }} />
        )}
      </View>
    );
  }

  const isAndroid = Platform.OS === "android";
  const isDarkMode = colorScheme === "dark";
  const canStart =
    Boolean(flow.selectedProject) &&
    Boolean(flow.selectedModel) &&
    flow.prompt.trim().length > 0 &&
    isIncomingShareReady &&
    !isImportingShare &&
    !flow.submitting &&
    !(flow.workspaceMode === "worktree" && !flow.selectedBranchName);
  const promptEditor = (
    <ComposerEditor
      ref={promptInputRef}
      // The context-first screen intentionally opens with the keyboard closed.
      // Focusing is a user action, so presenting the form sheet has one motion.
      autoFocus={false}
      editable={!isIncomingShareTransferPending}
      multiline
      scrollEnabled
      value={flow.prompt}
      skills={flow.selectedProviderSkills}
      onChangeText={flow.setPrompt}
      onFocus={() => setIsComposerFocused(true)}
      onBlur={() => setIsComposerFocused(false)}
      onPasteImages={(uris) => void handleNativePasteImages(uris)}
      placeholder="Ask anything…"
      singleLineCentered={false}
      contentInsetVertical={0}
      style={{
        minHeight: 72,
        maxHeight: 160,
        paddingHorizontal: 4,
        paddingVertical: 4,
      }}
      textStyle={{ ...bodyText, color: foregroundColor, fontFamily: regularFontFamily }}
    />
  );

  const closeNewTask = () => {
    void KeyboardController.dismiss({ animated: true });
    const parentNavigation = navigation.getParent();
    if (parentNavigation) {
      parentNavigation.goBack();
      return;
    }
    navigation.goBack();
  };
  const chooseProject = () => {
    if (isIncomingShareTransferPending) {
      return;
    }
    promptInputRef.current?.blur();
    void KeyboardController.dismiss({ animated: true });
    navigation.dispatch(StackActions.push("NewTask", { incomingShareId: props.incomingShareId }));
  };
  const openContextPicker = (routeName: "NewTaskBranch" | "NewTaskEnvironment") => {
    if (isIncomingShareTransferPending) {
      return;
    }
    promptInputRef.current?.blur();
    void KeyboardController.dismiss({ animated: true });
    navigation.dispatch(StackActions.push(routeName));
  };

  const hero = (
    <View className="items-center gap-6 px-6" testID="new-task-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we build
        </Text>
        <View className="max-w-full flex-row items-center justify-center">
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">in </Text>
          <Pressable
            accessibilityHint="Opens the project picker"
            accessibilityLabel={`Change project from ${selectedProject.title}`}
            accessibilityRole="button"
            disabled={isIncomingShareTransferPending}
            onPress={chooseProject}
            className="min-w-0 max-w-[250px] active:opacity-65"
            style={{
              borderBottomColor: projectUnderlineColor,
              borderBottomWidth: 1,
            }}
          >
            <Text
              className="text-2xl font-t3-medium tracking-tight text-foreground"
              numberOfLines={1}
            >
              {selectedProject.title}
            </Text>
          </Pressable>
          <Text className="text-2xl font-t3-medium tracking-tight text-foreground">?</Text>
        </View>
      </View>

      <ComposerInlineControl
        accessibilityLabel={`Environment: ${selectedEnvironmentLabel}`}
        chevronDirection="right"
        disabled={isIncomingShareTransferPending}
        icon="desktopcomputer"
        label={`on ${selectedEnvironmentLabel}`}
        maxWidth={260}
        onPress={
          flow.environments.length > 1 ? () => openContextPicker("NewTaskEnvironment") : undefined
        }
        showChevron={flow.environments.length > 1}
        static={flow.environments.length <= 1}
      />
    </View>
  );
  const heroViewport = (
    <View className="flex-1" collapsable={false}>
      <ScrollView
        alwaysBounceVertical={isKeyboardVisible}
        className="flex-1"
        contentInsetAdjustmentBehavior="never"
        contentContainerClassName="grow items-center pb-[236px] pt-12 ios:pt-[72px]"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        testID="new-task-hero-scroll"
      >
        {hero}
      </ScrollView>
    </View>
  );

  const workspaceControls = (
    <View className="flex-row items-center gap-1 px-2">
      <ComposerInlineControl
        accessibilityHint={`Switches to ${flow.workspaceMode === "local" ? "a new worktree" : "the current checkout"}`}
        accessibilityLabel={workspaceLabel}
        disabled={isIncomingShareTransferPending}
        iconNode={
          <NewTaskWorkspaceIcon
            workspaceMode={flow.workspaceMode}
            worktreePath={flow.selectedWorktreePath}
          />
        }
        label={workspaceLabel}
        maxWidth={flow.workspaceMode === "local" ? 220 : 148}
        onPress={() => flow.setWorkspaceMode(flow.workspaceMode === "local" ? "worktree" : "local")}
        showChevron={false}
      />

      <ComposerInlineControl
        accessibilityLabel={`${flow.workspaceMode === "worktree" ? "Base branch" : "Branch"}: ${selectedBranchLabel}`}
        chevronDirection="right"
        disabled={isIncomingShareTransferPending}
        icon="arrow.triangle.branch"
        label={showBranchLoading ? "Loading branches…" : selectedBranchLabel}
        maxWidth={190}
        onPress={() => openContextPicker("NewTaskBranch")}
      />
    </View>
  );

  const composerDock = (
    <View className="bg-sheet px-4 pt-1" style={{ paddingBottom: controlsBottomPadding }}>
      <View className="pb-1">{workspaceControls}</View>

      <ComposerSurface
        animateLayout={false}
        isDarkMode={isDarkMode}
        style={{
          borderRadius: 26,
          minHeight: 140,
          overflow: "hidden",
          paddingBottom: 6,
          paddingHorizontal: 14,
          paddingTop: 14,
        }}
      >
        {flow.attachments.length > 0 ? (
          <View className="pb-2.5">
            <ComposerAttachmentStrip
              attachments={flow.attachments}
              imageBorderRadius={16}
              imageSize={72}
              onRemove={isIncomingShareTransferPending ? () => undefined : flow.removeAttachment}
            />
          </View>
        ) : null}

        {promptEditor}

        <ComposerToolbarRow paddingBottom={0} paddingHorizontal={0} paddingTop={4}>
          <ComposerToolbarScroller
            fadeOpaque={sheetFadeOpaque}
            fadeTransparent={sheetFadeTransparent}
            contentPaddingRight={8}
          >
            <ComposerToolbarButton
              accessibilityLabel="Add attachment"
              disabled={isIncomingShareTransferPending}
              icon="plus"
              onPress={() => void handlePickImages()}
              showChevron={false}
            />
            <ComposerInlineControl
              accessibilityLabel="Model and reasoning settings"
              disabled={isIncomingShareTransferPending}
              emphasized
              iconNode={
                <ProviderIcon provider={flow.selectedModelOption?.providerDriver} size={16} />
              }
              label={flow.selectedModelOption?.label ?? "Choose model"}
              maxWidth={152}
              onPress={settingsSheetPresentation.open}
            />
            {flow.planModeEnabled ? (
              <ComposerInlineControl
                accessibilityHint={`Switches to ${flow.interactionMode === "plan" ? "Build" : "Plan"} mode`}
                accessibilityLabel={`Interaction mode: ${flow.interactionMode === "plan" ? "Plan" : "Build"}`}
                disabled={isIncomingShareTransferPending}
                emphasized
                icon={
                  flow.interactionMode === "plan"
                    ? { ios: "list.bullet.clipboard", android: "auto_awesome" }
                    : { ios: "hammer", android: "construction" }
                }
                label={flow.interactionMode === "plan" ? "Plan" : "Build"}
                onPress={() =>
                  flow.setInteractionMode(flow.interactionMode === "plan" ? "default" : "plan")
                }
                showChevron={false}
              />
            ) : null}
          </ComposerToolbarScroller>
          <ComposerToolbarButton
            accessibilityLabel={
              flow.submitting ? "Starting task" : environmentConnected ? "Start task" : "Queue task"
            }
            disabled={!canStart}
            icon={environmentConnected ? "arrow.up" : "tray.and.arrow.up"}
            onPress={() => void handleStart()}
            showChevron={false}
            variant="primary"
          />
        </ComposerToolbarRow>
      </ComposerSurface>
    </View>
  );

  if (isAndroid) {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title="New task" onBack={closeNewTask} />
        {heroViewport}

        <KeyboardStickyView
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
          offset={{ closed: 0, opened: keyboardOpenedOffset }}
        >
          {composerDock}
        </KeyboardStickyView>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerBackVisible: false,
          headerShadowVisible: false,
          title: "",
        }}
      />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Cancel new task"
          label="Cancel"
          onPress={closeNewTask}
        />
      </NativeHeaderToolbar>

      {heroViewport}
      <KeyboardStickyView
        style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
        offset={{ closed: 0, opened: keyboardOpenedOffset }}
      >
        {composerDock}
      </KeyboardStickyView>
    </View>
  );
}
