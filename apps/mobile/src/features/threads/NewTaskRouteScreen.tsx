import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import { cn } from "../../lib/cn";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects } from "../../state/entities";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { getProjectScopeSelectionTarget } from "./new-task-project-selection";

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

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const foregroundColor = useThemeColor("--color-foreground");
  const fontFamily = useFontFamily("regular");
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const [projectQuery, setProjectQuery] = useState("");
  const showsProjectSearch = projectScopes.length > 0;
  const filteredProjectScopes = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    if (query.length === 0) {
      return projectScopes;
    }
    return projectScopes.filter(
      (scope) =>
        scope.title.toLocaleLowerCase().includes(query) ||
        scope.projects.some(
          (project) =>
            project.title.toLocaleLowerCase().includes(query) ||
            project.workspaceRoot.toLocaleLowerCase().includes(query),
        ),
    );
  }, [projectQuery, projectScopes]);
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
                      onPress: () => navigation.dispatch(StackActions.push("AddProject")),
                    },
                  ]
                : []
            }
          />
          {showsProjectSearch ? (
            <View className="px-5 pb-2 pt-3">
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                className="h-11 rounded-xl bg-card px-4 text-base text-foreground"
                onChangeText={setProjectQuery}
                placeholder="Find a project"
                placeholderTextColor={placeholderColor}
                style={{ color: foregroundColor, fontFamily }}
                value={projectQuery}
              />
            </View>
          ) : null}
        </>
      ) : (
        <>
          <NativeStackScreenOptions
            options={{
              title: screenTitle,
              unstable_headerSubtitle: incomingShareSubtitle ?? undefined,
              unstable_headerToolbarItems:
                showsProjectSearch && usesNativeMailSearchToolbar
                  ? () => [
                      createNativeMailSearchToolbarItem({
                        onSearchTextChange: setProjectQuery,
                        placeholder: "Find a project",
                        searchTextChangeId: "new-task-project-search-text",
                        showsSearchDismissButton: true,
                      }),
                    ]
                  : undefined,
              headerSearchBarOptions:
                showsProjectSearch && !usesNativeMailSearchToolbar
                  ? {
                      allowToolbarIntegration: true,
                      autoCapitalize: "none",
                      hideNavigationBar: false,
                      obscureBackground: false,
                      placeholder: "Find a project",
                      onChangeText: (event) => {
                        setProjectQuery(event.nativeEvent.text);
                      },
                      onCancelButtonPress: () => {
                        setProjectQuery("");
                      },
                    }
                  : undefined,
            }}
          />
          {showsProjectSearch && !usesNativeMailSearchToolbar ? (
            <NativeHeaderToolbar placement="bottom">
              <NativeHeaderToolbar.SearchBarSlot />
            </NativeHeaderToolbar>
          ) : null}
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
                onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
                separateBackground
              />
            ) : null}
          </NativeHeaderToolbar>
        </>
      )}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          gap: 12,
          paddingBottom:
            Math.max(insets.bottom, 18) +
            18 +
            (usesNativeMailSearchToolbar ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET : 0),
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
                onPress={() => navigation.dispatch(StackActions.push("AddProject"))}
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add new project
                </Text>
              </Pressable>
            )}
          </View>
        ) : filteredProjectScopes.length === 0 ? (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            <Text className="text-center text-lg font-t3-bold text-foreground">
              No matching projects
            </Text>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No projects match your search.
            </Text>
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {filteredProjectScopes.map((scope, scopeIndex) => {
              const hasMultipleProjects = scope.projects.length > 1;
              const selectionTarget = getProjectScopeSelectionTarget(scope, selectedEnvironmentId);
              return (
                <View
                  key={scope.key}
                  className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                >
                  <Pressable
                    disabled={reservedDestinationProject !== null}
                    onPress={() => void selectProject(selectionTarget)}
                    className="flex-row items-center gap-3 bg-card px-4 py-3.5"
                  >
                    <View className="h-7 w-7 items-center justify-center">
                      <ProjectFavicon
                        environmentId={scope.representative.environmentId}
                        faviconPath={scope.representative.faviconPath}
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
                          : selectionTarget.workspaceRoot}
                      </Text>
                    </View>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColor={chevronColor}
                      type="monochrome"
                    />
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
