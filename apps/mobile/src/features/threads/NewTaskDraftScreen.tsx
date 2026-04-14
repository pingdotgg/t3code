import { MenuView } from "@react-native-menu/menu";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { TextInputWrapper } from "expo-paste-input";
import { useCallback, useEffect, useMemo } from "react";
import { Pressable, View, useColorScheme } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import { CLAUDE_CODE_EFFORT_OPTIONS } from "@t3tools/contracts";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPill } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";

import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { buildThreadRoutePath } from "../../lib/routes";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useNativePaste } from "../../hooks/useNativePaste";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { useProjectActions } from "./use-project-actions";

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
}) {
  const { projects } = useRemoteCatalog();
  const { onCreateThreadWithOptions } = useProjectActions();
  const flow = useNewTaskFlow();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const keyboard = useAnimatedKeyboard();
  const containerAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value,
  }));
  const controlsBottomPadding = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value > 0 ? 4 : Math.max(insets.bottom, 10),
  }));
  const { logicalProjects, selectedProject, setProject } = flow;

  const iconColor = useThemeColor("--color-icon");
  const borderColor = useThemeColor("--color-border");

  useEffect(() => {
    if (props.initialProjectRef?.environmentId && props.initialProjectRef?.projectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === props.initialProjectRef?.environmentId &&
            project.id === props.initialProjectRef?.projectId,
        ) ?? null;

      if (directProject) {
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

    router.replace("/new");
  }, [
    logicalProjects,
    projects,
    props.initialProjectRef?.environmentId,
    props.initialProjectRef?.projectId,
    router,
    selectedProject,
    setProject,
  ]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    void flow.loadBranches();
  }, [flow, selectedProject]);

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
            model.selection.provider === flow.selectedModel.provider &&
            model.selection.model === flow.selectedModel.model,
        )?.label,
        subactions: group.models.map((option) => ({
          id: `model:${option.key}`,
          title: option.label,
          state:
            flow.selectedModel &&
            option.selection.provider === flow.selectedModel.provider &&
            option.selection.model === flow.selectedModel.model
              ? ("on" as const)
              : undefined,
        })),
      })),
    [flow.providerGroups, flow.selectedModel],
  );

  const optionsMenuActions = useMemo(
    () => [
      {
        id: "options-effort",
        title: "Effort",
        subtitle: `${flow.effort.charAt(0).toUpperCase()}${flow.effort.slice(1)}`,
        subactions: CLAUDE_CODE_EFFORT_OPTIONS.map((level) => ({
          id: `options:effort:${level}`,
          title: `${level}${level === "high" ? " (default)" : ""}`,
          state: flow.effort === level ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-fast-mode",
        title: "Fast Mode",
        subtitle: flow.fastMode ? "On" : "Off",
        subactions: ([false, true] as const).map((value) => ({
          id: `options:fast-mode:${value ? "on" : "off"}`,
          title: value ? "On" : "Off",
          state: flow.fastMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "options-context-window",
        title: "Context Window",
        subtitle: flow.contextWindow,
        subactions: (["200k", "1M"] as const).map((value) => ({
          id: `options:context-window:${value}`,
          title: `${value}${value === "1M" ? " (default)" : ""}`,
          state: flow.contextWindow === value ? ("on" as const) : undefined,
        })),
      },
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
    [flow.contextWindow, flow.effort, flow.fastMode, flow.interactionMode, flow.runtimeMode],
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
        subtitle: flow.workspaceMode === "local" ? "Local" : "Worktree",
        subactions: (["local", "worktree"] as const).map((value) => ({
          id: `workspace:mode:${value}`,
          title: value === "local" ? "Local" : "Worktree",
          state: flow.workspaceMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "workspace:branch",
        title: "Branch",
        subtitle: flow.selectedBranchName ?? "Choose branch",
        subactions: branchActions,
      },
    ];
  }, [
    flow.availableBranches,
    flow.branchesLoading,
    flow.selectedBranchName,
    flow.selectedProject,
    flow.workspaceMode,
  ]);

  function handleModelMenuAction(event: string) {
    if (!event.startsWith("model:")) {
      return;
    }
    // Defer state update so the native menu dismiss animation completes
    // before re-rendering the menu actions (prevents submenu jump).
    setTimeout(() => {
      flow.setSelectedModelKey(event.slice("model:".length));
    }, 150);
  }

  function handleEnvironmentMenuAction(event: string) {
    if (!event.startsWith("environment:")) {
      return;
    }
    flow.selectEnvironment(EnvironmentId.make(event.slice("environment:".length)));
  }

  function handleOptionsMenuAction(event: string) {
    if (event.startsWith("options:effort:")) {
      flow.setEffort(event.slice("options:effort:".length) as typeof flow.effort);
      return;
    }
    if (event.startsWith("options:fast-mode:")) {
      flow.setFastMode(event.endsWith(":on"));
      return;
    }
    if (event.startsWith("options:context-window:")) {
      flow.setContextWindow(event.slice("options:context-window:".length));
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

  const handleNativePaste = useNativePaste((uris) => {
    void handleNativePasteImages(uris);
  });

  async function handleStart(): Promise<void> {
    if (
      !flow.selectedProject ||
      !flow.selectedModel ||
      flow.prompt.trim().length === 0 ||
      flow.submitting ||
      (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
    ) {
      return;
    }

    flow.setSubmitting(true);
    try {
      const modelWithOptions: ModelSelection =
        flow.selectedModel.provider === "claudeAgent"
          ? {
              ...flow.selectedModel,
              options: {
                effort: flow.effort,
                fastMode: flow.fastMode || undefined,
                contextWindow: flow.contextWindow,
              },
            }
          : flow.selectedModel.provider === "codex"
            ? { ...flow.selectedModel, options: { fastMode: flow.fastMode || undefined } }
            : flow.selectedModel;

      const createdThread = await onCreateThreadWithOptions({
        project: flow.selectedProject,
        modelSelection: modelWithOptions,
        envMode: flow.workspaceMode,
        branch: flow.selectedBranchName,
        worktreePath: flow.workspaceMode === "worktree" ? null : flow.selectedWorktreePath,
        runtimeMode: flow.runtimeMode,
        interactionMode: flow.interactionMode,
        initialMessageText: flow.prompt.trim(),
        initialAttachments: flow.attachments,
      });

      if (createdThread) {
        router.replace(buildThreadRoutePath(createdThread));
      }
    } finally {
      flow.setSubmitting(false);
    }
  }

  if (!selectedProject) {
    return (
      <View className="flex-1 bg-sheet">
        <View style={{ minHeight: 16, paddingTop: 8 }} />
        <View className="items-center gap-1 px-5 pb-3 pt-4">
          <Text
            className="text-[12px] font-t3-bold uppercase text-foreground-muted"
            style={{ letterSpacing: 1 }}
          >
            New task
          </Text>
          <Text className="text-[28px] font-t3-bold">Loading task</Text>
        </View>
      </View>
    );
  }

  return (
    <Animated.View className="flex-1 bg-sheet" style={containerAnimatedStyle}>
      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        {flow.logicalProjects.length > 1 ? (
          <Pressable
            className="absolute left-3 top-4 h-9 w-9 items-center justify-center rounded-full bg-subtle"
            style={{ zIndex: 1 }}
            onPress={() => router.back()}
          >
            <SymbolView
              name="chevron.left"
              size={16}
              tintColor={iconColor}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        ) : null}
        <Text
          className="text-[12px] font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          New task
        </Text>
        <Text className="text-[28px] font-t3-bold">{selectedProject.title}</Text>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8 }}>
        <TextInputWrapper onPaste={(payload) => void handleNativePaste(payload)}>
          <TextInput
            multiline
            value={flow.prompt}
            onChangeText={flow.setPrompt}
            placeholder={`Describe a coding task in ${selectedProject.title}`}
            textAlignVertical="top"
            className="flex-1 border-0 bg-transparent text-[18px] leading-[28px]"
          />
        </TextInputWrapper>
      </View>

      <Animated.View
        style={[
          {
            borderTopWidth: 1,
            borderTopColor: borderColor,
          },
          controlsBottomPadding,
        ]}
      >
        {flow.attachments.length > 0 ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <ComposerAttachmentStrip
              attachments={flow.attachments}
              onRemove={flow.removeAttachment}
              imageSize={88}
              imageBorderRadius={20}
            />
          </View>
        ) : null}
        <View className="flex-row items-center justify-between gap-2 px-4 pb-1 pt-4">
          <ControlPill icon="plus" onPress={() => void handlePickImages()} />
          <MenuView
            actions={modelMenuActions}
            onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill
              iconNode={<ProviderIcon provider={flow.selectedModel?.provider} size={16} />}
            />
          </MenuView>
          <MenuView
            actions={optionsMenuActions}
            onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill icon="slider.horizontal.3" />
          </MenuView>
          <MenuView
            actions={environmentMenuActions}
            onPressAction={({ nativeEvent }) => handleEnvironmentMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill icon="desktopcomputer" />
          </MenuView>
          <MenuView
            actions={workspaceMenuActions}
            onPressAction={({ nativeEvent }) => handleWorkspaceMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill icon="point.topleft.down.curvedto.point.bottomright.up" />
          </MenuView>
          <ControlPill
            icon="arrow.up"
            label={flow.submitting ? "Starting" : "Start"}
            onPress={() => void handleStart()}
            variant="primary"
            disabled={
              !flow.selectedProject ||
              !flow.selectedModel ||
              flow.prompt.trim().length === 0 ||
              flow.submitting ||
              (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
            }
          />
        </View>
      </Animated.View>
    </Animated.View>
  );
}
