import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Alert, InteractionManager, View, useColorScheme } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  providerOptionsConfigurationLabel,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { useProjects } from "../../state/entities";
import { deriveThreadTitleFromPrompt } from "../../lib/projectThreadStartTurn";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { enqueueThreadOutboxMessage, removeThreadOutboxMessage } from "../../state/thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { useCreateProjectThread } from "./use-project-actions";

function formatWorkspaceLabel(input: {
  readonly workspaceMode: string;
  readonly currentBranchName: string | null;
  readonly selectedBranchName: string | null;
}): string {
  const branchName = input.selectedBranchName ?? input.currentBranchName;
  if (input.workspaceMode === "worktree") {
    return branchName ? `New worktree · ${branchName}` : "New worktree";
  }
  return branchName ? `Current · ${branchName}` : "Current checkout";
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
  /** Queued outbox message id when editing an existing pending task. */
  readonly pendingTaskId?: string;
}) {
  const projects = useProjects();
  const createProjectThread = useCreateProjectThread();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = isKeyboardVisible ? 8 : Math.max(insets.bottom, 10);
  const { logicalProjects, selectedProject, setProject } = flow;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const environmentConnected =
    selectedProject !== null &&
    connectedEnvironments.find(
      (environment) => environment.environmentId === selectedProject.environmentId,
    )?.connectionState === "connected";
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const appliedInitialProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      appliedInitialProjectKeyRef.current = null;
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

  const headlineText = useScaledTextRole("headline");
  const sheetFadeOpaque = colorScheme === "dark" ? "rgba(14,14,14,0.98)" : "rgba(242,242,247,0.98)";
  const sheetFadeTransparent = colorScheme === "dark" ? "rgba(14,14,14,0)" : "rgba(242,242,247,0)";

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
    if (!selectedProject) {
      return;
    }

    let focusFrame: ReturnType<typeof requestAnimationFrame> | null = null;
    const interaction = InteractionManager.runAfterInteractions(() => {
      focusFrame = requestAnimationFrame(() => promptInputRef.current?.focus());
    });

    return () => {
      interaction.cancel();
      if (focusFrame !== null) {
        cancelAnimationFrame(focusFrame);
      }
    };
  }, [selectedProject]);

  const environmentMenuActions = useMemo(
    () =>
      flow.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.environmentLabel,
        state:
          flow.selectedEnvironmentId === environment.environmentId ? ("on" as const) : undefined,
      })),
    [flow.environments, flow.selectedEnvironmentId],
  );

  const modelMenuActions = useMemo(
    () =>
      flow.providerGroups.map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subtitle: group.models.find(
          (model) =>
            flow.selectedModel &&
            model.selection.instanceId === flow.selectedModel.instanceId &&
            model.selection.model === flow.selectedModel.model,
        )?.label,
        subactions: group.models.map((option) => ({
          id: `model:${option.key}`,
          title: option.label,
          state:
            flow.selectedModel &&
            option.selection.instanceId === flow.selectedModel.instanceId &&
            option.selection.model === flow.selectedModel.model
              ? ("on" as const)
              : undefined,
        })),
      })),
    [flow.providerGroups, flow.selectedModel],
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
              : "Full access",
        subactions: [
          { id: "options:runtime:approval-required", title: "Approve actions" },
          { id: "options:runtime:auto-accept-edits", title: "Auto-accept edits" },
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
  const currentBranchName =
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const configurationLabel = useMemo(
    () => providerOptionsConfigurationLabel(providerOptionDescriptors),
    [providerOptionDescriptors],
  );
  const workspaceLabel = useMemo(
    () =>
      formatWorkspaceLabel({
        currentBranchName,
        selectedBranchName: flow.selectedBranchName,
        workspaceMode: flow.workspaceMode,
      }),
    [currentBranchName, flow.selectedBranchName, flow.workspaceMode],
  );
  function handleModelMenuAction(event: string) {
    if (!event.startsWith("model:")) {
      return;
    }
    flow.setSelectedModelKey(event.slice("model:".length));
  }

  function handleEnvironmentMenuAction(event: string) {
    if (!event.startsWith("environment:")) {
      return;
    }
    flow.selectEnvironment(EnvironmentId.make(event.slice("environment:".length)));
  }

  function handleOptionsMenuAction(event: string) {
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

  async function handlePickImages(): Promise<void> {
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
    const modelSelection = draft.modelSelection ?? flow.selectedModel;
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
        flow.setPrompt("");
        flow.clearAttachments();
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
      flow.setPrompt("");
      flow.clearAttachments();
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
      <View className="flex-1 bg-sheet">
        <NativeStackScreenOptions options={{ title: "Loading task" }} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: selectedProject.title }} />

      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View className="min-h-0 flex-1 px-5 pt-2">
          <ComposerEditor
            ref={promptInputRef}
            autoFocus
            multiline
            scrollEnabled
            value={flow.prompt}
            skills={flow.selectedProviderSkills}
            onChangeText={flow.setPrompt}
            onPasteImages={(uris) => void handleNativePasteImages(uris)}
            placeholder={`Describe a coding task in ${selectedProject.title}`}
            style={{ flex: 1, minHeight: 0 }}
            textStyle={headlineText}
          />
        </View>

        <View className="border-t border-border" style={{ paddingBottom: controlsBottomPadding }}>
          {flow.attachments.length > 0 ? (
            <View className="px-4 pt-3">
              <ComposerAttachmentStrip
                attachments={flow.attachments}
                onRemove={flow.removeAttachment}
                imageSize={88}
                imageBorderRadius={20}
              />
            </View>
          ) : null}
          <ComposerToolbarRow paddingBottom={controlsBottomPadding} paddingHorizontal={6}>
            <ComposerToolbarScroller
              fadeOpaque={sheetFadeOpaque}
              fadeTransparent={sheetFadeTransparent}
            >
              <ComposerToolbarButton
                icon="plus"
                onPress={() => void handlePickImages()}
                showChevron={false}
              />
              <ControlPillMenu
                actions={modelMenuActions}
                onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Model"
                  iconNode={
                    <ProviderIcon provider={flow.selectedModelOption?.providerDriver} size={16} />
                  }
                  label={flow.selectedModelOption?.label ?? "Model"}
                />
              </ControlPillMenu>
              <ControlPillMenu
                actions={optionsMenuActions}
                onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Configuration"
                  icon="slider.horizontal.3"
                  label={configurationLabel}
                />
              </ControlPillMenu>
              <ControlPillMenu
                actions={environmentMenuActions}
                onPressAction={({ nativeEvent }) => handleEnvironmentMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Environment"
                  icon="desktopcomputer"
                  label={selectedEnvironmentLabel}
                />
              </ControlPillMenu>
              <ControlPillMenu
                actions={workspaceMenuActions}
                onPressAction={({ nativeEvent }) => handleWorkspaceMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Workspace"
                  icon="point.topleft.down.curvedto.point.bottomright.up"
                  label={workspaceLabel}
                />
              </ControlPillMenu>
            </ComposerToolbarScroller>
            <ComposerToolbarButton
              accessibilityLabel={
                flow.submitting
                  ? "Starting task"
                  : environmentConnected
                    ? "Start task"
                    : "Queue task"
              }
              icon={environmentConnected ? "arrow.up" : "tray.and.arrow.up"}
              onPress={() => void handleStart()}
              variant="primary"
              showChevron={false}
              disabled={
                !flow.selectedProject ||
                !flow.selectedModel ||
                flow.prompt.trim().length === 0 ||
                flow.submitting ||
                (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
              }
            />
          </ComposerToolbarRow>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
