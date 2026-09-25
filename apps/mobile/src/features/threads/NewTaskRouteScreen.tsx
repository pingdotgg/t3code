import { MaterialListRow } from "../../components/MaterialListRow";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  type ColorValue,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { ControlPillMenu } from "../../components/ControlPill";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { useConfirmRemoveProjects } from "../projects/useConfirmRemoveProjects";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects } from "../../state/entities";
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

const PROJECT_ROW_MENU_ACTIONS: MenuAction[] = [
  {
    id: "remove-project",
    title: "Remove project",
    image: "trash",
    attributes: { destructive: true },
  },
];

/** Swipe left for Remove; a tap on an open row only closes its actions. */
/** Presses arriving this soon after a swipe drag are the drag's own finger-up. */
const SWIPE_PRESS_GRACE_MS = 600;

const SwipeableProjectRow = memo(function SwipeableProjectRow(props: {
  // Primitive props only: the picker re-renders on every thread update while
  // an agent works, and an open swipe must survive that untouched.
  readonly scopeKey: string;
  readonly title: string;
  readonly subtitle: string;
  readonly environmentId: EnvironmentProject["environmentId"];
  readonly faviconPath: EnvironmentProject["faviconPath"];
  readonly workspaceRoot: string;
  readonly isFirst: boolean;
  readonly disabled: boolean;
  readonly backgroundColor: ColorValue;
  readonly fullSwipeWidth: number;
  readonly onSelect: (scopeKey: string) => void;
  readonly onRemove: (scopeKey: string) => void;
}) {
  const { disabled, scopeKey, title, onRemove, onSelect } = props;
  // Lifting the finger at the end of a swipe still reaches the Pressable as a
  // press (the touch never left the row), so presses right after a drag are
  // dropped; only a later tap on an open row closes it.
  const swipeOpenRef = useRef(false);
  const lastSwipeAtRef = useRef(0);
  const markSwipedOpen = useCallback(() => {
    swipeOpenRef.current = true;
    lastSwipeAtRef.current = Date.now();
  }, []);
  const markSwipedClosed = useCallback(() => {
    swipeOpenRef.current = false;
    lastSwipeAtRef.current = Date.now();
  }, []);
  const remove = useCallback(() => {
    if (!disabled) onRemove(scopeKey);
  }, [disabled, onRemove, scopeKey]);
  const removeAction = useMemo(
    () => ({
      accessibilityLabel: `Remove project ${title}`,
      icon: "trash" as const,
      label: "Remove",
      tone: "danger" as const,
      onPress: remove,
    }),
    [remove, title],
  );
  return (
    <ThreadSwipeable
      backgroundColor={props.backgroundColor}
      compactActions
      enabled={!disabled}
      fullSwipeWidth={props.fullSwipeWidth}
      onDelete={remove}
      onSwipeableWillOpen={markSwipedOpen}
      onSwipeableClose={markSwipedClosed}
      primaryAction={removeAction}
      resetKey={scopeKey}
      secondaryAction={null}
      threadKey={scopeKey}
      threadTitle={title}
    >
      {(close) => (
        <View className={cn(!props.isFirst && "border-t border-border-subtle")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={title}
            accessibilityHint="Swipe left to remove the project"
            disabled={props.disabled}
            onPress={() => {
              if (Date.now() - lastSwipeAtRef.current < SWIPE_PRESS_GRACE_MS) return;
              if (swipeOpenRef.current) {
                close();
                return;
              }
              onSelect(scopeKey);
            }}
            className="bg-card"
          >
            <View className="flex-row items-center gap-3 px-4 py-3.5">
              <View className="h-7 w-7 items-center justify-center">
                <ProjectFavicon
                  environmentId={props.environmentId}
                  faviconPath={props.faviconPath}
                  size={20}
                  projectTitle={title}
                  workspaceRoot={props.workspaceRoot}
                />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-base font-t3-bold leading-snug">{title}</Text>
                <Text
                  className="text-xs leading-snug text-foreground-muted"
                  ellipsizeMode="middle"
                  numberOfLines={1}
                >
                  {props.subtitle}
                </Text>
              </View>
              <SymbolView
                name="chevron.right"
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </View>
          </Pressable>
        </View>
      )}
    </ThreadSwipeable>
  );
});

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const [searchText, setSearchText] = useState("");
  const { projectScopes, selectedEnvironmentId, setProject } = useNewTaskFlow();
  const { width: windowWidth } = useWindowDimensions();
  const cardColor = useAppearancePreferences().themeVariables["--color-card"];
  // This picker is the one place mobile lists every project, so it doubles
  // as the place to remove one: swipe on iOS, long-press on Android.
  const confirmRemoveProjects = useConfirmRemoveProjects();
  const removeScope = (scope: (typeof projectScopes)[number]) => {
    void confirmRemoveProjects(scope.projects, { groupTitle: scope.title });
  };
  // The memoized iOS rows receive stable callbacks that resolve the current
  // scope by key at press time instead of closing over per-render objects.
  const latest = { projectScopes, removeScope, selectProject, selectedEnvironmentId };
  const latestRef = useRef(latest);
  useEffect(() => {
    latestRef.current = latest;
  });
  const [rowActions] = useState(() => ({
    remove(scopeKey: string) {
      const scope = latestRef.current.projectScopes.find((entry) => entry.key === scopeKey);
      if (scope) latestRef.current.removeScope(scope);
    },
    select(scopeKey: string) {
      const scope = latestRef.current.projectScopes.find((entry) => entry.key === scopeKey);
      if (scope) {
        void latestRef.current.selectProject(
          getProjectScopeSelectionTarget(scope, latestRef.current.selectedEnvironmentId),
        );
      }
    },
  }));
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
                <MaterialButton
                  label={catalogState.hasReadyEnvironment ? "Add new project" : "Add environment"}
                  tone="primary"
                  onPress={() =>
                    catalogState.hasReadyEnvironment
                      ? navigation.dispatch(StackActions.push("AddProject"))
                      : navigation.navigate("ConnectionsNew")
                  }
                />
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
                    <ControlPillMenu
                      key={scope.key}
                      actions={PROJECT_ROW_MENU_ACTIONS}
                      onPressAction={({ nativeEvent }) => {
                        if (nativeEvent.event === "remove-project") removeScope(scope);
                      }}
                      shouldOpenOnLongPress
                    >
                      <MaterialListRow
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
                            size={24}
                            projectTitle={scope.title}
                            workspaceRoot={scope.representative.workspaceRoot}
                          />
                        }
                      />
                    </ControlPillMenu>
                  );
                }
                return (
                  <SwipeableProjectRow
                    key={scope.key}
                    backgroundColor={cardColor}
                    disabled={reservedDestinationProject !== null}
                    environmentId={scope.representative.environmentId}
                    faviconPath={scope.representative.faviconPath}
                    fullSwipeWidth={windowWidth - 40}
                    isFirst={scopeIndex === 0}
                    onRemove={rowActions.remove}
                    onSelect={rowActions.select}
                    scopeKey={scope.key}
                    subtitle={
                      hasMultipleProjects
                        ? `${scope.projects.length} workspaces`
                        : selectionTarget.workspaceRoot
                    }
                    title={scope.title}
                    workspaceRoot={scope.representative.workspaceRoot}
                  />
                );
              })}
            </View>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
