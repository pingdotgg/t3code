import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { buildNewTaskEnvironmentItems, deriveNewTaskPickerEmptyState } from "./newTaskPicker";

type NewTaskEnvironmentRouteParams = {
  readonly incomingShareId?: string | string[];
};

export function NewTaskEnvironmentRouteScreen({
  route,
}: StaticScreenProps<NewTaskEnvironmentRouteParams | undefined>) {
  const projects = useProjects();
  const threads = useThreadShells();
  const workspace = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
  const { getShare } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const environmentItems = useMemo(
    () =>
      buildNewTaskEnvironmentItems({
        environments: workspace.environments,
        projects,
        threads,
      }),
    [projects, threads, workspace.environments],
  );
  const emptyState = deriveNewTaskPickerEmptyState(workspace.state);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose where to run what you shared"
      : incomingShare.attachments.length === 1
        ? "Choose where to run the image you shared"
        : `Choose where to run the ${incomingShare.attachments.length} images you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose environment";

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (
      resumedDestinationKeyRef.current === destinationKey ||
      reservedDestinationProject === null
    ) {
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

  const addProject = () => navigation.navigate("NewTaskSheet", { screen: "AddProject" });

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={screenTitle}
            subtitle={incomingShareSubtitle}
            onBack={layout.usesSplitView ? () => navigation.goBack() : undefined}
            actions={[
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: addProject,
              },
            ]}
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
            <NativeHeaderToolbar.Button icon="plus" onPress={addProject} separateBackground />
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
        {environmentItems.length === 0 ? (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            {emptyState.loading ? <ActivityIndicator color={accentColor} /> : null}
            <Text className="text-center text-lg font-t3-bold text-foreground">
              {emptyState.title}
            </Text>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              {emptyState.detail}
            </Text>
            {!workspace.state.hasReadyEnvironment ? (
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
                onPress={addProject}
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add new project
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {environmentItems.map((item, index) => {
              const isFirst = index === 0;
              const isLast = index === environmentItems.length - 1;

              return (
                <Pressable
                  key={item.environmentId}
                  accessibilityLabel={`${item.environmentLabel}, ${item.projectCount} ${
                    item.projectCount === 1 ? "project" : "projects"
                  }`}
                  accessibilityRole="button"
                  disabled={reservedDestinationProject !== null}
                  onPress={() =>
                    navigation.navigate("NewTaskSheet", {
                      screen: "NewTaskProject",
                      params: {
                        environmentId: item.environmentId,
                        incomingShareId: incomingShare?.id,
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
                      <SymbolView
                        name="desktopcomputer"
                        size={20}
                        tintColor={accentColor}
                        type="monochrome"
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-base leading-snug font-t3-bold">
                        {item.environmentLabel}
                      </Text>
                      <Text className="text-sm text-foreground-muted">
                        {item.projectCount} {item.projectCount === 1 ? "project" : "projects"}
                      </Text>
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
