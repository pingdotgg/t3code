import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, usePreventRemove } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, View, useColorScheme } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
  ComposerToolbarTrigger,
} from "../../components/ComposerToolbarTrigger";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPillMenu } from "../../components/ControlPill";
import { ModelPickerSheet } from "../../components/ModelPickerSheet";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ComposerSurface } from "./ThreadComposer";

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  restoreComposerDraftSnapshot,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { resolveSelectableModelSelection } from "../../lib/modelOptions";
import { deriveThreadTitleFromPrompt } from "../../lib/projectThreadStartTurn";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { enqueueThreadOutboxMessage, removeThreadOutboxMessage } from "../../state/thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { useCreateProjectThread } from "./use-project-actions";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useModelFavorites } from "./useModelFavorites";

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
  const colorScheme = useColorScheme();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = isKeyboardVisible ? 8 : Math.max(insets.bottom, 10);
  const { logicalProjects, selectedProject, setProject } = flow;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const { favoriteModelKeys, favoritesReady, toggleFavorite } = useModelFavorites(
    selectedProject?.environmentId ?? null,
  );
  const environmentConnected =
    selectedProject !== null &&
    connectedEnvironments.find(
      (environment) => environment.environmentId === selectedProject.environmentId,
    )?.connectionState === "connected";
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const [importingShareKey, setImportingShareKey] = useState<string | null>(null);
  const [isCancellingShareImport, setIsCancellingShareImport] = useState(false);
  const [cancelledIncomingShareId, setCancelledIncomingShareId] = useState<string | null>(null);
  const [isReturningToProjectPicker, setIsReturningToProjectPicker] = useState(false);
  const [shareImportAttempt, setShareImportAttempt] = useState(0);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
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
  const bodyText = useScaledTextRole("body");
  const headlineText = useScaledTextRole("headline");

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

    if (selectedProject) {
      return;
    }

    if (logicalProjects.length === 1) {
      setProject(logicalProjects[0]!.project);
      return;
    }

    navigation.dispatch(StackActions.replace("NewTask"));
  }, [
    logicalProjects,
    projects,
    props.initialProjectRef,
    props.incomingShareId,
    props.pendingTaskId,
    navigation,
    selectedProject,
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
    void flow.loadBranches();
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

  const environmentMenuActions = useMemo(
    () =>
      flow.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.environmentLabel,
        attributes: isIncomingShareTransferPending ? { disabled: true } : undefined,
        state:
          flow.selectedEnvironmentId === environment.environmentId ? ("on" as const) : undefined,
      })),
    [flow.environments, flow.selectedEnvironmentId, isIncomingShareTransferPending],
  );

  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: flow.selectedModelOption?.capabilities,
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption?.capabilities],
  );

  const optionsMenuActions = useMemo(
    () => [
      ...buildProviderOptionMenuActions(providerOptionDescriptors),
      {
        id: "options-runtime",
        title: "Runtime",
        subtitle:
          flow.runtimeMode === "approval-required"
            ? "Approve actions"
            : flow.runtimeMode === "auto-accept-edits"
              ? "Auto-accept edits"
              : flow.runtimeMode === "auto"
                ? "Auto"
                : "Full access",
        subactions: [
          { id: "options:runtime:approval-required", title: "Approve actions" },
          { id: "options:runtime:auto-accept-edits", title: "Auto-accept edits" },
          { id: "options:runtime:auto", title: "Auto" },
          { id: "options:runtime:full-access", title: "Full access" },
        ].map((option) => {
          const value = option.id.replace("options:runtime:", "");
          return {
            id: option.id,
            title: option.title,
            state: flow.runtimeMode === value ? ("on" as const) : undefined,
          };
        }),
      },
      {
        id: "options-interaction",
        title: "Interaction",
        subtitle: flow.interactionMode === "plan" ? "Plan" : "Default",
        subactions: [
          { id: "options:interaction:default", title: "Default" },
          { id: "options:interaction:plan", title: "Plan" },
        ].map((option) => {
          const value = option.id.replace("options:interaction:", "");
          return {
            id: option.id,
            title: option.title,
            state: flow.interactionMode === value ? ("on" as const) : undefined,
          };
        }),
      },
    ],
    [flow.interactionMode, flow.runtimeMode, providerOptionDescriptors],
  );

  const workspaceMenuActions = useMemo(() => {
    const branchActions =
      flow.availableBranches.length === 0
        ? [
            {
              id: "workspace:branch:none",
              title: flow.branchesLoading ? "Loading branches…" : "No branches available",
              attributes: { disabled: true },
            },
          ]
        : flow.availableBranches.slice(0, 12).map((branch) => {
            const badge = branchBadgeLabel({
              branch,
              project: flow.selectedProject,
            });

            return {
              id: `workspace:branch:${branch.name}`,
              title: branch.name,
              subtitle: badge ? badge.toUpperCase() : undefined,
              state: flow.selectedBranchName === branch.name ? ("on" as const) : undefined,
            };
          });

    return [
      {
        id: "workspace:mode",
        title: "Mode",
        subtitle: flow.workspaceMode === "local" ? "Current checkout" : "New worktree",
        subactions: (["local", "worktree"] as const).map((value) => ({
          id: `workspace:mode:${value}`,
          title: value === "local" ? "Current checkout" : "New worktree",
          state: flow.workspaceMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "workspace:branch",
        title: "Branch",
        subtitle: flow.selectedBranchName ?? "Choose branch",
        subactions: branchActions,
      },
      ...(flow.workspaceMode === "worktree"
        ? [
            {
              id: "workspace:start-from-origin",
              title: "Start from origin",
              subtitle: "Base the worktree on the latest origin branch",
              image: "arrow.triangle.pull",
              state: flow.startFromOrigin ? ("on" as const) : undefined,
            },
          ]
        : []),
    ];
  }, [
    flow.availableBranches,
    flow.branchesLoading,
    flow.selectedBranchName,
    flow.selectedProject,
    flow.startFromOrigin,
    flow.workspaceMode,
  ]);

  const selectedEnvironmentLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ?? "Environment";
  const configurationMenuActions = useMemo(
    () => [
      ...optionsMenuActions,
      {
        id: "options-environment",
        title: "Environment",
        subtitle: selectedEnvironmentLabel,
        subactions: environmentMenuActions,
      },
      ...workspaceMenuActions,
    ],
    [environmentMenuActions, optionsMenuActions, selectedEnvironmentLabel, workspaceMenuActions],
  );
  function handleEnvironmentMenuAction(event: string) {
    if (isIncomingShareTransferPending || !event.startsWith("environment:")) {
      return;
    }
    flow.selectEnvironment(EnvironmentId.make(event.slice("environment:".length)));
  }

  function handleOptionsMenuAction(event: string) {
    if (isIncomingShareTransferPending) {
      return;
    }
    const providerOptions = applyProviderOptionMenuEvent(providerOptionDescriptors, event);
    if (providerOptions) {
      flow.setSelectedModelOptions(providerOptions);
      return;
    }
    if (event.startsWith("options:runtime:")) {
      flow.setRuntimeMode(
        event.slice("options:runtime:".length) as Parameters<typeof flow.setRuntimeMode>[0],
      );
      return;
    }
    if (event.startsWith("options:interaction:")) {
      flow.setInteractionMode(
        event.slice("options:interaction:".length) as Parameters<typeof flow.setInteractionMode>[0],
      );
    }
  }

  function handleWorkspaceMenuAction(event: string) {
    if (isIncomingShareTransferPending) {
      return;
    }
    if (event.startsWith("workspace:mode:")) {
      flow.setWorkspaceMode(
        event.slice("workspace:mode:".length) as Parameters<typeof flow.setWorkspaceMode>[0],
      );
      return;
    }
    if (event === "workspace:start-from-origin") {
      flow.setStartFromOrigin(!flow.startFromOrigin);
      return;
    }
    if (event.startsWith("workspace:branch:")) {
      const branchName = event.slice("workspace:branch:".length);
      const branch = flow.availableBranches.find((candidate) => candidate.name === branchName);
      if (branch) {
        flow.selectBranch(branch);
      }
    }
  }

  function handleConfigurationMenuAction(event: string) {
    handleOptionsMenuAction(event);
    handleEnvironmentMenuAction(event);
    handleWorkspaceMenuAction(event);
  }

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
    const interactionMode = draft.interactionMode ?? flow.interactionMode;
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
      threadTitle: deriveThreadTitleFromPrompt(initialMessageText),
      projectTitle: selectedProject.title,
    });
    const result = await createProjectThread({
      project: selectedProject,
      modelSelection,
      envMode: workspaceMode,
      branch: selectedBranchName,
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
      <View className="flex-1 bg-screen">
        <NativeStackScreenOptions options={{ headerShown: false }} />
      </View>
    );
  }

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
      autoFocus={false}
      editable={!isIncomingShareTransferPending}
      multiline
      scrollEnabled
      value={flow.prompt}
      skills={flow.selectedProviderSkills}
      onChangeText={flow.setPrompt}
      onPasteImages={(uris) => void handleNativePasteImages(uris)}
      placeholder="Ask anything..."
      contentInsetVertical={0}
      style={{
        minHeight: 76,
        maxHeight: 160,
        paddingHorizontal: 4,
        paddingVertical: 4,
      }}
      textStyle={{ ...bodyText, color: foregroundColor }}
    />
  );

  const toolbarPills = (
    <>
      <ComposerToolbarButton
        accessibilityLabel="Add attachment"
        disabled={isIncomingShareTransferPending}
        icon="paperclip"
        onPress={() => void handlePickImages()}
        showChevron={false}
        variant="ghost"
      />
      <ComposerToolbarTrigger
        accessibilityLabel="Choose model"
        disabled={isIncomingShareTransferPending}
        iconNode={<ProviderIcon provider={flow.selectedModelOption?.providerDriver} size={18} />}
        label={flow.selectedModelOption?.label ?? "Model"}
        onPress={() => {
          Keyboard.dismiss();
          setModelPickerVisible(true);
        }}
        variant="ghost"
      />
      <ControlPillMenu
        actions={configurationMenuActions}
        onPressAction={({ nativeEvent }) => handleConfigurationMenuAction(nativeEvent.event)}
      >
        <ComposerToolbarTrigger
          accessibilityLabel="Configuration"
          disabled={isIncomingShareTransferPending}
          icon="slider.horizontal.3"
          showChevron={false}
          variant="ghost"
        />
      </ControlPillMenu>
    </>
  );

  const startButton = (
    <ComposerToolbarButton
      accessibilityLabel={
        flow.submitting ? "Starting task" : environmentConnected ? "Start task" : "Queue task"
      }
      icon="arrow.up"
      onPress={() => void handleStart()}
      variant="primary"
      showChevron={false}
      disabled={!canStart}
    />
  );

  return (
    <View
      className="flex-1 overflow-hidden"
      style={{
        backgroundColor: isDarkMode ? "#000000" : "#f2f2f7",
        borderColor: isDarkMode ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.1)",
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderTopWidth: 1,
      }}
    >
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View style={{ paddingTop: Math.max(insets.top, 8) }}>
          <Pressable
            accessibilityRole="button"
            disabled={isIncomingShareTransferPending || isCancellingShareImport}
            hitSlop={8}
            onPress={() => navigation.goBack()}
            className="self-start px-4 py-3 active:opacity-60"
            style={{
              opacity: isIncomingShareTransferPending || isCancellingShareImport ? 0.45 : 1,
            }}
          >
            <Text className="text-sm text-foreground-muted">Cancel</Text>
          </Pressable>
        </View>

        <View className="min-h-0 flex-1 items-center justify-center px-6 pb-12">
          <Text
            className="text-center font-t3-medium text-foreground"
            style={[headlineText, { fontSize: 28, lineHeight: 34, letterSpacing: -0.6 }]}
          >
            What should we build
          </Text>
          <View className="max-w-full flex-row items-center justify-center">
            <Text
              className="font-t3-medium text-foreground"
              style={[headlineText, { fontSize: 28, lineHeight: 34, letterSpacing: -0.6 }]}
            >
              in{" "}
            </Text>
            <View
              className="max-w-[240px] border-b border-foreground-muted"
              style={{ borderStyle: "dotted" }}
            >
              <Text
                className="font-t3-medium text-foreground"
                ellipsizeMode="tail"
                numberOfLines={1}
                style={[headlineText, { fontSize: 28, lineHeight: 34, letterSpacing: -0.6 }]}
              >
                {selectedProject.title}
              </Text>
            </View>
            <Text
              className="font-t3-medium text-foreground"
              style={[headlineText, { fontSize: 28, lineHeight: 34, letterSpacing: -0.6 }]}
            >
              ?
            </Text>
          </View>
          <View className="mt-2 flex-row items-center gap-1.5">
            <SymbolView
              name="desktopcomputer"
              size={12}
              tintColor={isDarkMode ? "#66676d" : "#8e8e93"}
              type="monochrome"
            />
            <Text className="text-xs text-foreground-tertiary">on {selectedEnvironmentLabel}</Text>
          </View>
        </View>

        <View
          style={{ paddingBottom: controlsBottomPadding, paddingHorizontal: 10, paddingTop: 8 }}
        >
          <ComposerSurface
            isDarkMode={isDarkMode}
            style={{
              backgroundColor: isDarkMode ? "rgba(17,17,19,0.95)" : "rgba(255,255,255,0.95)",
              borderRadius: 22,
              overflow: "hidden",
              paddingBottom: 6,
              paddingHorizontal: 12,
              paddingTop: 10,
            }}
          >
            {flow.attachments.length > 0 ? (
              <View className="pb-2.5">
                <ComposerAttachmentStrip
                  attachments={flow.attachments}
                  onRemove={
                    isIncomingShareTransferPending ? () => undefined : flow.removeAttachment
                  }
                />
              </View>
            ) : null}
            {promptEditor}
            <ComposerToolbarRow paddingBottom={0} paddingHorizontal={0} paddingTop={4}>
              <ComposerToolbarScroller
                fadeOpaque={isDarkMode ? "rgba(17,17,19,0.95)" : "rgba(255,255,255,0.95)"}
                fadeTransparent={isDarkMode ? "rgba(17,17,19,0)" : "rgba(255,255,255,0)"}
              >
                {toolbarPills}
              </ComposerToolbarScroller>
              {startButton}
            </ComposerToolbarRow>
          </ComposerSurface>
        </View>
      </KeyboardAvoidingView>
      <ModelPickerSheet
        favoriteModelKeys={favoriteModelKeys}
        favoritesEnabled={favoritesReady}
        groups={flow.providerGroups}
        onClose={() => setModelPickerVisible(false)}
        onSelectModel={(option) => flow.setSelectedModelKey(option.key)}
        onToggleFavorite={toggleFavorite}
        selectedModel={flow.selectedModel}
        visible={modelPickerVisible}
      />
    </View>
  );
}
