import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { useAtomSet } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { deriveProjectGroupingOverrideKey } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { cn } from "../../lib/cn";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects } from "../../state/entities";
import {
  mobileProjectGroupingOverridesPatch,
  useMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
};

function buildProjectGroupingMenuActions(
  currentOverride: SidebarProjectGroupingMode | undefined,
): MenuAction[] {
  return [
    {
      id: "inherit",
      title: "Use default",
      state: currentOverride === undefined ? "on" : "off",
    },
    {
      id: "repository",
      title: "Group by repository",
      state: currentOverride === "repository" ? "on" : "off",
    },
    {
      id: "repository_path",
      title: "Group by repository path",
      state: currentOverride === "repository_path" ? "on" : "off",
    },
    {
      id: "separate",
      title: "Keep separate",
      state: currentOverride === "separate" ? "on" : "off",
    },
  ];
}

function deriveProjectEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment before creating a task.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Environment unavailable",
      detail:
        catalogState.connectionError ??
        "The saved environment is offline. Check the URL or start the environment, then retry.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to environment",
      detail: "Loading projects from the saved environment.",
      loading: true,
    };
  }

  return {
    title: "No projects found",
    detail: "The connected environment did not report any projects.",
    loading: false,
  };
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const { projectScopes } = useNewTaskFlow();
  const groupingSettings = useMobileProjectGroupingSettings();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const { getShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a project for what you shared"
      : incomingShare.attachments.length === 1
        ? "Choose a project for the image you shared"
        : `Choose a project for the ${incomingShare.attachments.length} images you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose project";
  const projectEmptyState = deriveProjectEmptyState(catalogState);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;

  async function selectProject(project: EnvironmentProject): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Alert.alert(
          "Could not change project",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        incomingShareId: incomingShare?.id,
      },
    });
  }

  function toggleGroup(groupKey: string): void {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  function updateProjectGrouping(
    project: EnvironmentProject,
    mode: SidebarProjectGroupingMode | "inherit",
  ): void {
    const overrideKey = deriveProjectGroupingOverrideKey(project);
    const nextOverrides = { ...groupingSettings.sidebarProjectGroupingOverrides };
    if (mode === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = mode;
    }
    savePreferences(mobileProjectGroupingOverridesPatch(nextOverrides));
  }

  function handleProjectGroupingAction(project: EnvironmentProject, actionId: string): void {
    if (
      actionId === "inherit" ||
      actionId === "repository" ||
      actionId === "repository_path" ||
      actionId === "separate"
    ) {
      updateProjectGrouping(project, actionId);
    }
  }

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Returning from the reserved draft is a fresh resume attempt. Keeping
      // this latch set would leave every project row disabled with no route.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: reservedDestinationProject.environmentId,
        projectId: reservedDestinationProject.id,
        title: reservedDestinationProject.title,
        incomingShareId: incomingShare.id,
      },
    });
  }, [incomingShare, isFocused, navigation, reservedDestinationProject]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={screenTitle}
            subtitle={incomingShareSubtitle}
            onBack={layout.usesSplitView ? () => navigation.goBack() : undefined}
            actions={
              catalogState.hasReadyEnvironment
                ? [
                    {
                      accessibilityLabel: "Add project",
                      icon: "plus",
                      onPress: () => navigation.navigate("NewTaskSheet", { screen: "AddProject" }),
                    },
                  ]
                : []
            }
          />
        </>
      ) : (
        <>
          <NativeStackScreenOptions
            options={{
              title: screenTitle,
              unstable_headerSubtitle: incomingShareSubtitle ?? undefined,
            }}
          />
          <NativeHeaderToolbar placement="right">
            {layout.usesSplitView ? (
              <NativeHeaderToolbar.Button
                accessibilityLabel="Close new task"
                icon="xmark"
                onPress={() => navigation.goBack()}
                separateBackground
              />
            ) : null}
            {catalogState.hasReadyEnvironment ? (
              <NativeHeaderToolbar.Button
                icon="plus"
                onPress={() => navigation.navigate("NewTaskSheet", { screen: "AddProject" })}
                separateBackground
              />
            ) : null}
          </NativeHeaderToolbar>
        </>
      )}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 20,
          paddingTop: 8,
        }}
      >
        {projectScopes.length === 0 ? (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            {projectEmptyState.loading ? <ActivityIndicator color={accentColor} /> : null}
            <Text className="text-center text-lg font-t3-bold text-foreground">
              {projectEmptyState.title}
            </Text>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              {projectEmptyState.detail}
            </Text>
            {!catalogState.hasReadyEnvironment ? (
              <Pressable
                className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                onPress={() => navigation.navigate("ConnectionsNew")}
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add environment
                </Text>
              </Pressable>
            ) : (
              <Pressable
                className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                onPress={() => navigation.navigate("NewTaskSheet", { screen: "AddProject" })}
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add new project
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {projectScopes.map((scope, scopeIndex) => {
              const hasMultipleProjects = scope.projects.length > 1;
              const expanded = expandedGroupKeys.has(scope.key);
              const singleProject = hasMultipleProjects ? null : scope.projects[0];
              return (
                <View
                  key={scope.key}
                  className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                >
                  <Pressable
                    disabled={singleProject !== null && reservedDestinationProject !== null}
                    onPress={() => {
                      if (singleProject) {
                        void selectProject(singleProject);
                      } else {
                        toggleGroup(scope.key);
                      }
                    }}
                    className="flex-row items-center gap-3 bg-card px-4 py-3.5"
                  >
                    <View className="h-7 w-7 items-center justify-center">
                      <ProjectFavicon
                        environmentId={scope.representative.environmentId}
                        size={20}
                        projectTitle={scope.title}
                        workspaceRoot={scope.representative.workspaceRoot}
                      />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-base leading-snug font-t3-bold">{scope.title}</Text>
                      <Text
                        className="text-xs leading-snug text-foreground-muted"
                        ellipsizeMode="middle"
                        numberOfLines={1}
                      >
                        {hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : singleProject?.workspaceRoot}
                      </Text>
                    </View>
                    {singleProject ? (
                      <ControlPillMenu
                        actions={buildProjectGroupingMenuActions(
                          groupingSettings.sidebarProjectGroupingOverrides[
                            deriveProjectGroupingOverrideKey(singleProject)
                          ],
                        )}
                        isAnchoredToRight
                        onPressAction={({ nativeEvent }) => {
                          handleProjectGroupingAction(singleProject, nativeEvent.event);
                        }}
                      >
                        <Pressable
                          accessibilityLabel={`Grouping options for ${singleProject.title}`}
                          hitSlop={8}
                          className="p-1"
                        >
                          <SymbolView
                            name="ellipsis"
                            size={16}
                            tintColor={chevronColor}
                            type="monochrome"
                          />
                        </Pressable>
                      </ControlPillMenu>
                    ) : null}
                    <SymbolView
                      name={hasMultipleProjects && expanded ? "chevron.down" : "chevron.right"}
                      size={14}
                      tintColor={chevronColor}
                      type="monochrome"
                    />
                  </Pressable>
                  {hasMultipleProjects && expanded
                    ? scope.projects.map((project) => (
                        <Pressable
                          key={scopedProjectKey(project.environmentId, project.id)}
                          disabled={reservedDestinationProject !== null}
                          onPress={() => void selectProject(project)}
                          className="flex-row items-center gap-3 border-t border-border-subtle bg-card py-3 pr-4 pl-10"
                        >
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            size={18}
                            projectTitle={project.title}
                            workspaceRoot={project.workspaceRoot}
                          />
                          <View className="min-w-0 flex-1">
                            <Text className="text-sm font-t3-bold text-foreground">
                              {project.title}
                            </Text>
                            <Text
                              className="text-xs text-foreground-muted"
                              ellipsizeMode="middle"
                              numberOfLines={1}
                            >
                              {project.workspaceRoot}
                            </Text>
                          </View>
                          <ControlPillMenu
                            actions={buildProjectGroupingMenuActions(
                              groupingSettings.sidebarProjectGroupingOverrides[
                                deriveProjectGroupingOverrideKey(project)
                              ],
                            )}
                            isAnchoredToRight
                            onPressAction={({ nativeEvent }) => {
                              handleProjectGroupingAction(project, nativeEvent.event);
                            }}
                          >
                            <Pressable
                              accessibilityLabel={`Grouping options for ${project.title}`}
                              hitSlop={8}
                              className="p-1"
                            >
                              <SymbolView
                                name="ellipsis"
                                size={16}
                                tintColor={chevronColor}
                                type="monochrome"
                              />
                            </Pressable>
                          </ControlPillMenu>
                          <SymbolView
                            name="chevron.right"
                            size={14}
                            tintColor={chevronColor}
                            type="monochrome"
                          />
                        </Pressable>
                      ))
                    : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
