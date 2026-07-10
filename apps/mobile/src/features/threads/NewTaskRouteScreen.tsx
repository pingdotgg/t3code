import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "expo-symbols";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { cn } from "../../lib/cn";

import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useThreadShells } from "../../state/entities";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { groupProjectsByRepository } from "../../lib/repositoryGroups";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";

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

export function NewTaskRouteScreen() {
  const projects = useProjects();
  const threads = useThreadShells();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
  const repositoryGroups = useMemo(
    () => groupProjectsByRepository({ projects, threads }),
    [projects, threads],
  );
  const items = useMemo(() => {
    const nextItems: Array<{
      readonly environmentId: EnvironmentId;
      readonly id: ProjectId;
      readonly key: string;
      readonly title: string;
      readonly workspaceRoot: string;
    }> = [];
    for (const group of repositoryGroups) {
      const project = group.projects[0]?.project;
      if (!project) {
        continue;
      }
      nextItems.push({
        environmentId: project.environmentId,
        id: project.id,
        key: group.key,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
    return nextItems;
  }, [repositoryGroups]);
  const projectEmptyState = deriveProjectEmptyState(catalogState);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeHeaderToolbar placement="right">
        {layout.usesSplitView ? (
          <NativeHeaderToolbar.Button
            accessibilityLabel="Close new task"
            icon="xmark"
            onPress={() => navigation.goBack()}
            separateBackground
          />
        ) : null}
        <NativeHeaderToolbar.Button
          icon="plus"
          onPress={() => navigation.navigate("NewTaskSheet", { screen: "AddProject" })}
          separateBackground
        />
      </NativeHeaderToolbar>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 8,
        }}
      >
        {items.length === 0 ? (
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
            {items.map((item, index) => {
              const isFirst = index === 0;
              const isLast = index === items.length - 1;

              return (
                <Pressable
                  key={item.key}
                  onPress={() =>
                    navigation.navigate("NewTaskSheet", {
                      screen: "NewTaskDraft",
                      params: {
                        environmentId: item.environmentId,
                        projectId: item.id,
                        title: item.title,
                      },
                    })
                  }
                  className={cn(
                    "bg-card px-4 py-3.5",
                    !isFirst && "border-t border-border-subtle",
                    isFirst && "rounded-t-[24px]",
                    isLast && "rounded-b-[24px]",
                  )}
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="h-7 w-7 items-center justify-center">
                      <ProjectFavicon
                        environmentId={item.environmentId}
                        size={20}
                        projectTitle={item.title}
                        workspaceRoot={item.workspaceRoot}
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-base leading-snug font-t3-bold">{item.title}</Text>
                    </View>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColor={chevronColor}
                      type="monochrome"
                    />
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
