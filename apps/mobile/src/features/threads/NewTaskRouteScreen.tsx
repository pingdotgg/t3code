import { MaterialListRow } from "../../components/MaterialListRow";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects, useServerConfigs, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { filterProjectScopes, getProjectScopeSelectionTarget } from "./new-task-project-selection";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
};

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

function NewTaskHeader(props: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly canAddProject: boolean;
  readonly searchText: string;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  return (
    <ScreenHeader
      title={props.title}
      subtitle={props.subtitle ?? undefined}
      sidebar={false}
      backInSplitView={{
        accessibilityLabel: "Go back",
        icon: "chevron.left",
      }}
      options={{ headerBackVisible: !layout.usesSplitView }}
      hideBottomBorder
      onBack={() => navigation.goBack()}
      actions={
        props.canAddProject
          ? [
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: () => navigation.dispatch(StackActions.push("AddProject")),
              },
            ]
          : []
      }
      search={{
        value: props.searchText,
        onChangeText: props.onSearchTextChange,
        placeholder: "Search projects",
      }}
    />
  );
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { getShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "Choose a project for what you shared"
      : incomingShare.attachments.length === 1
        ? `Choose a project for the ${incomingShare.attachments[0]?.type === "image" ? "image" : "file"} you shared`
        : `Choose a project for the ${incomingShare.attachments.length} ${incomingShare.attachments.every((attachment) => attachment.type === "image") ? "images" : "files"} you shared`
    : null;
  const screenTitle = incomingShare ? "Start a task" : "Choose project";
  const projectEmptyState = deriveProjectEmptyState(catalogState);
  const visibleScopes = filterProjectScopes(projectScopes, searchText);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, {
    reportFailure: false,
  });
  // Scratch needs a connected environment whose server offers the folder.
  // The selected environment wins when it has one; otherwise the first that does.
  const scratchEnvironments = connectedEnvironments.filter(
    (environment) =>
      canCreateProjectInEnvironment(environment.connectionState) &&
      serverConfigs.get(environment.environmentId)?.scratchWorkspaceRoot !== undefined,
  );
  const scratchEnvironment =
    scratchEnvironments.find(
      (environment) => environment.environmentId === selectedEnvironmentId,
    ) ??
    scratchEnvironments[0] ??
    null;
  const scratchWorkspaceRoot = scratchEnvironment
    ? (serverConfigs.get(scratchEnvironment.environmentId)?.scratchWorkspaceRoot ?? null)
    : null;
  // Once the Scratch project exists it is an ordinary row in the list.
  const scratchProjectExists =
    scratchEnvironment !== null &&
    scratchWorkspaceRoot !== null &&
    findProjectByPath(
      projects.filter((project) => project.environmentId === scratchEnvironment.environmentId),
      scratchWorkspaceRoot,
    ) !== undefined;
  const canStartScratch = scratchWorkspaceRoot !== null && reservedDestinationProject === null;
  const scratchStartInFlightRef = useRef(false);

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
    const state = navigation.getState();
    const previousRoute = state?.routes[state.index - 1];
    if (previousRoute?.name === "NewTaskDraft") {
      setProject(project);
      navigation.goBack();
      return;
    }

    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        incomingShareId: incomingShare?.id,
      }),
    );
  }

  async function startScratch(): Promise<void> {
    if (!scratchEnvironment || scratchStartInFlightRef.current) return;
    const environmentId = scratchEnvironment.environmentId;
    scratchStartInFlightRef.current = true;
    try {
      const result = await ensureScratch({ environmentId, input: {} });
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not open Scratch",
          error instanceof Error ? error.message : "The Scratch folder could not be created.",
        );
        return;
      }
      const project = await waitForProject({ environmentId, projectId: result.value.projectId });
      if (project === null) {
        Alert.alert(
          "Could not open Scratch",
          "Scratch has not reached this device yet. Pick it from the project list once it appears.",
        );
        return;
      }
      await selectProject(project);
    } finally {
      scratchStartInFlightRef.current = false;
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
    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        environmentId: reservedDestinationProject.environmentId,
        projectId: reservedDestinationProject.id,
        title: reservedDestinationProject.title,
        incomingShareId: incomingShare.id,
      }),
    );
  }, [incomingShare, isFocused, navigation, reservedDestinationProject]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NewTaskHeader
        title={screenTitle}
        subtitle={incomingShareSubtitle}
        canAddProject={catalogState.hasReadyEnvironment}
        searchText={searchText}
        onSearchTextChange={setSearchText}
      />

      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: Platform.OS === "android" ? 8 : 12,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: Platform.OS === "android" ? 16 : 20,
            paddingTop: Platform.OS === "android" ? 16 : 8,
            ...(Platform.OS === "android" && visibleScopes.length === 0
              ? { flexGrow: 1, justifyContent: "center" as const }
              : {}),
          }}
        >
          {projectScopes.length === 0 ? (
            <View
              collapsable={false}
              className={cn(
                "items-center gap-3 px-6 py-8",
                Platform.OS !== "android" && "rounded-[24px] bg-card",
              )}
            >
              {projectEmptyState.loading ? (
                <ActivityIndicator colorClassName="accent-icon-muted" />
              ) : null}
              <Text className="text-center text-lg font-t3-bold text-foreground">
                {projectEmptyState.title}
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {projectEmptyState.detail}
              </Text>
              {Platform.OS === "android" ? (
                <>
                  <MaterialButton
                    label={catalogState.hasReadyEnvironment ? "Add new project" : "Add environment"}
                    tone="primary"
                    onPress={() =>
                      catalogState.hasReadyEnvironment
                        ? navigation.dispatch(StackActions.push("AddProject"))
                        : navigation.navigate("ConnectionsNew")
                    }
                  />
                  {canStartScratch ? (
                    <MaterialButton
                      label="Start in Scratch"
                      tone="secondary"
                      onPress={() => void startScratch()}
                    />
                  ) : null}
                </>
              ) : !catalogState.hasReadyEnvironment ? (
                <Pressable
                  className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                  onPress={() => navigation.navigate("ConnectionsNew")}
                >
                  <Text className="text-sm font-t3-bold text-primary-foreground">
                    Add environment
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                    onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                  >
                    <Text className="text-sm font-t3-bold text-primary-foreground">
                      Add new project
                    </Text>
                  </Pressable>
                  {canStartScratch ? (
                    <Pressable
                      className="rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
                      onPress={() => void startScratch()}
                    >
                      <Text className="text-sm font-t3-bold text-foreground">Start in Scratch</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          ) : visibleScopes.length === 0 ? (
            <View className="items-center gap-2 px-6 py-8">
              <Text className="text-center text-lg font-t3-bold text-foreground">
                No matching projects
              </Text>
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                Try a different project name or workspace path.
              </Text>
            </View>
          ) : (
            <View
              collapsable={false}
              className={
                Platform.OS === "android"
                  ? "overflow-hidden rounded-[28px] bg-card"
                  : "overflow-hidden rounded-[24px] bg-card"
              }
            >
              {visibleScopes.map((scope, scopeIndex) => {
                const hasMultipleProjects = scope.projects.length > 1;
                const selectionTarget = getProjectScopeSelectionTarget(
                  scope,
                  selectedEnvironmentId,
                );
                if (Platform.OS === "android") {
                  return (
                    <MaterialListRow
                      key={scope.key}
                      title={scope.title}
                      subtitle={
                        hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : selectionTarget.workspaceRoot
                      }
                      disabled={reservedDestinationProject !== null}
                      onPress={() => void selectProject(selectionTarget)}
                      leading={
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={24}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      }
                    />
                  );
                }
                return (
                  <View
                    key={scope.key}
                    className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={scope.title}
                      disabled={reservedDestinationProject !== null}
                      onPress={() => void selectProject(selectionTarget)}
                      className="flex-row items-center gap-3 bg-card px-4 py-3.5"
                    >
                      <View className="h-7 w-7 items-center justify-center">
                        <ProjectFavicon
                          environmentId={scope.representative.environmentId}
                          faviconPath={scope.representative.faviconPath}
                          projectIcon={scope.representative.projectIcon}
                          size={20}
                          projectTitle={scope.title}
                          workspaceRoot={scope.representative.workspaceRoot}
                        />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className={cn("text-base leading-snug", "font-t3-bold")}>
                          {scope.title}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          ellipsizeMode="middle"
                          numberOfLines={1}
                        >
                          {hasMultipleProjects
                            ? `${scope.projects.length} workspaces`
                            : selectionTarget.workspaceRoot}
                        </Text>
                      </View>
                      <SymbolView
                        name="chevron.right"
                        size={14}
                        tintColorClassName="accent-chevron"
                        type="monochrome"
                      />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
          {canStartScratch && !scratchProjectExists && projectScopes.length > 0 ? (
            Platform.OS === "android" ? (
              <View collapsable={false} className="overflow-hidden rounded-[28px] bg-card">
                <MaterialListRow
                  title="Scratch"
                  subtitle="Start a task without a repository"
                  onPress={() => void startScratch()}
                  leading={
                    <SymbolView
                      name="pencil"
                      size={22}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  }
                />
              </View>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Scratch"
                  onPress={() => void startScratch()}
                  className="flex-row items-center gap-3 bg-card px-4 py-3.5"
                >
                  <View className="h-7 w-7 items-center justify-center">
                    <SymbolView
                      name="pencil"
                      size={18}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-bold leading-snug">Scratch</Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      Start a task without a repository
                    </Text>
                  </View>
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              </View>
            )
          ) : null}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
