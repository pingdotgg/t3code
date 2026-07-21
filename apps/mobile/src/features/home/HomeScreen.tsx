import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Easing,
  LinearTransition,
  type ExitAnimationsValues,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { relativeTime } from "../../lib/time";
import { threadStatusTone } from "../threads/threadPresentation";
import { buildHomeThreadGroups, type HomeProjectSortOrder } from "./homeThreadList";
import {
  THREAD_SWIPE_ACTIONS_WIDTH,
  THREAD_SWIPE_SPRING,
  ThreadSwipeActions,
} from "./thread-swipe-actions";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onAddConnection: () => void;
  readonly onOpenEnvironments: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
}

/* ─── Status indicator colors ────────────────────────────────────────── */

function statusColors(thread: EnvironmentThreadShell): { bg: string; fg: string } {
  switch (thread.session?.status) {
    case "running":
      return { bg: "rgba(249,115,22,0.14)", fg: "#f97316" };
    case "ready":
      return { bg: "rgba(34,197,94,0.14)", fg: "#22c55e" };
    case "starting":
      return { bg: "rgba(59,130,246,0.14)", fg: "#3b82f6" };
    case "error":
      return { bg: "rgba(239,68,68,0.14)", fg: "#ef4444" };
    default:
      return { bg: "rgba(163,163,163,0.10)", fg: "#a3a3a3" };
  }
}

const COLLAPSED_THREAD_LIMIT = 6;
const THREAD_LAYOUT_TRANSITION = LinearTransition.duration(220).easing(Easing.out(Easing.cubic));

function threadRowExit(values: ExitAnimationsValues) {
  "worklet";

  return {
    initialValues: {
      height: values.currentHeight,
      opacity: 1,
      originX: values.currentOriginX,
    },
    animations: {
      height: withDelay(
        90,
        withTiming(0, {
          duration: 170,
          easing: Easing.inOut(Easing.cubic),
        }),
      ),
      opacity: withDelay(80, withTiming(0, { duration: 100 })),
      originX: withTiming(values.currentOriginX - values.windowWidth, {
        duration: 190,
        easing: Easing.out(Easing.cubic),
      }),
    },
  };
}

function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
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
      detail: "Add an environment to load projects and start coding sessions.",
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
      detail: "Loading projects and threads from the saved environment.",
      loading: true,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected environment did not report any projects.",
      loading: false,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your connected projects.",
    loading: false,
  };
}

/* ─── Project group header ───────────────────────────────────────────── */

function ProjectGroupLabel(props: {
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly totalThreadCount: number;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
}) {
  const hiddenCount = props.totalThreadCount - COLLAPSED_THREAD_LIMIT;

  return (
    <View className="flex-row items-center gap-2.5 px-1 pb-2">
      <ProjectFavicon
        environmentId={props.project.environmentId}
        size={18}
        projectTitle={props.project.title}
        workspaceRoot={props.project.workspaceRoot}
      />
      <Text
        className="flex-1 text-xs font-t3-medium uppercase text-foreground-muted"
        style={{ letterSpacing: 0.5 }}
        numberOfLines={1}
      >
        {props.title}
      </Text>

      {hiddenCount > 0 ? (
        <Pressable onPress={props.onToggleExpand} hitSlop={8}>
          <Text
            className="text-xs font-t3-medium text-foreground-muted"
            style={{ letterSpacing: 0.4 }}
          >
            {props.isExpanded ? "Show less" : `${hiddenCount} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ─── Thread row ─────────────────────────────────────────────────────── */

function ThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
  readonly onPress: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly isLast: boolean;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const { width: windowWidth } = useWindowDimensions();
  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const cardColor = useThemeColor("--color-card");
  const fullSwipeThreshold = Math.max(THREAD_SWIPE_ACTIONS_WIDTH + 44, (windowWidth - 32) * 0.58);
  const { bg, fg } = statusColors(props.thread);
  const tone = threadStatusTone(props.thread);
  const timestamp = relativeTime(
    props.thread.latestUserMessageAt ?? props.thread.updatedAt ?? props.thread.createdAt,
  );
  const branch = props.thread.branch;
  const subtitleParts = [props.environmentLabel, branch].filter((part): part is string =>
    Boolean(part),
  );
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current && process.env.EXPO_OS === "ios") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: cardColor }}
      containerStyle={{ backgroundColor: cardColor }}
      dragOffsetFromRightEdge={8}
      enableTrackpadTwoFingerGesture
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;
        if (swipeableRef.current) {
          props.onSwipeableClose(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen(swipeableRef.current);
        }
      }}
      onSwipeableWillOpen={() => {
        const methods = swipeableRef.current;
        if (!methods) {
          return;
        }

        props.onSwipeableWillOpen(methods);
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();
          props.onDelete();
        }
      }}
      overshootFriction={1}
      overshootRight
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={cardColor}
          fullSwipeThreshold={fullSwipeThreshold}
          onDelete={props.onDelete}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            accessibilityLabel: `Archive ${props.thread.title}`,
            icon: "archivebox",
            label: "Archive",
            onPress: props.onArchive,
          }}
          swipeableMethods={methods}
          threadTitle={props.thread.title}
          translation={translation}
        />
      )}
      rightThreshold={THREAD_SWIPE_ACTIONS_WIDTH * 0.42}
    >
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={props.thread.title}
        accessibilityRole="button"
        className="bg-card"
        onPress={() => {
          swipeableRef.current?.close();
          props.onPress();
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          style={{
            flexDirection: "row",
            paddingLeft: 16,
            paddingRight: 16,
            paddingVertical: 10,
            gap: 12,
            borderBottomWidth: props.isLast ? 0 : 1,
            borderBottomColor: separatorColor,
          }}
        >
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              backgroundColor: bg,
              alignItems: "center",
              justifyContent: "center",
              marginTop: 2,
            }}
          >
            <SymbolView name="arrow.triangle.branch" size={13} tintColor={fg} type="monochrome" />
          </View>

          <View style={{ flex: 1, gap: 3 }}>
            <View className="flex-row items-center justify-between gap-2">
              <Text
                className="flex-1 text-base font-t3-bold leading-[20px] text-foreground"
                numberOfLines={1}
              >
                {props.thread.title}
              </Text>
              <View className="flex-row items-center gap-2">
                <View
                  className={tone.pillClassName}
                  style={{ borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2 }}
                >
                  <Text className={`text-3xs font-t3-bold ${tone.textClassName}`}>
                    {tone.label}
                  </Text>
                </View>
                <Text
                  className="text-xs text-foreground-tertiary"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {timestamp}
                </Text>
              </View>
            </View>

            {subtitleParts.length > 0 ? (
              <View className="flex-row items-center gap-1.5" style={{ marginTop: 1 }}>
                <SymbolView
                  name="arrow.triangle.branch"
                  size={10}
                  tintColor={iconSubtleColor}
                  type="monochrome"
                />
                <Text
                  className="text-2xs text-foreground-tertiary"
                  numberOfLines={1}
                  style={{ fontFamily: "monospace" }}
                >
                  {subtitleParts.join(" · ")}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

/* ─── Main screen ────────────────────────────────────────────────────── */

function staleCatalogPillLabel(props: { readonly catalogState: WorkspaceState }): string {
  if (props.catalogState.networkStatus === "offline") {
    return "You are offline";
  }
  const connectingEnvironments = props.catalogState.connectingEnvironments;
  if (connectingEnvironments.length === 1) {
    return `Reconnecting to ${connectingEnvironments[0]!.environmentLabel}`;
  }
  if (connectingEnvironments.length > 1) {
    return `Reconnecting ${connectingEnvironments.length} environments`;
  }
  return "Not connected";
}

function StaleCatalogStatusPill(props: {
  readonly catalogState: WorkspaceState;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const label = staleCatalogPillLabel(props);
  const isReconnecting = props.catalogState.connectingEnvironments.length > 0;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="flex-row items-center gap-2 rounded-full bg-card px-4 py-2.5"
      style={{
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.12,
        shadowRadius: 24,
      }}
    >
      {isReconnecting ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : (
        <SymbolView
          name="wifi.slash"
          size={15}
          tintColor={iconColor}
          type="monochrome"
          weight="semibold"
        />
      )}
      <Text className="max-w-[260px] text-sm font-t3-bold text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function HomeScreen(props: HomeScreenProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const accentColor = useThemeColor("--color-icon-muted");

  const toggleExpanded = useCallback((key: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const projectGroups = useMemo(
    () =>
      buildHomeThreadGroups({
        projects: props.projects,
        threads: props.threads,
        environmentId: props.selectedEnvironmentId,
        searchQuery: props.searchQuery,
        projectSortOrder: props.projectSortOrder,
        threadSortOrder: props.threadSortOrder,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [
      props.projectGroupingMode,
      props.projects,
      props.projectSortOrder,
      props.searchQuery,
      props.selectedEnvironmentId,
      props.threadSortOrder,
      props.threads,
    ],
  );

  /* Empty states */
  const hasAnyThreads = props.threads.some((thread) => thread.archivedAt === null);
  const hasResults = projectGroups.length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const shouldShowConnectionStatus =
    props.catalogState.networkStatus === "offline" ||
    props.catalogState.hasConnectingEnvironment ||
    (props.catalogState.hasLoadedShellSnapshot && !props.catalogState.hasReadyEnvironment);
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => openSwipeableRef.current?.close()}
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 24,
          gap: 20,
        }}
      >
        {!hasAnyThreads ? (
          <View>
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              actionLabel={!props.catalogState.hasReadyEnvironment ? "Add environment" : undefined}
              onAction={!props.catalogState.hasReadyEnvironment ? props.onAddConnection : undefined}
            />
            {emptyState.loading ? (
              <View className="absolute right-5 top-5">
                <ActivityIndicator color={accentColor} />
              </View>
            ) : null}
          </View>
        ) : !hasResults && hasSearchQuery ? (
          <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
        ) : !hasResults && selectedEnvironmentLabel ? (
          <EmptyState
            title={`No threads in ${selectedEnvironmentLabel}`}
            detail="Choose another environment or create a new task."
          />
        ) : !hasResults ? (
          <EmptyState
            title="No threads yet"
            detail="Create a task to start a new coding session."
          />
        ) : (
          projectGroups.map((group) => {
            const isExpanded = expandedProjects.has(group.key);
            const visibleThreads = isExpanded
              ? group.threads
              : group.threads.slice(0, COLLAPSED_THREAD_LIMIT);

            return (
              <Animated.View
                key={group.key}
                collapsable={false}
                exiting={threadRowExit}
                layout={THREAD_LAYOUT_TRANSITION}
                style={{ overflow: "hidden" }}
              >
                <ProjectGroupLabel
                  isExpanded={isExpanded}
                  onToggleExpand={() => toggleExpanded(group.key)}
                  project={group.representative}
                  title={group.title}
                  totalThreadCount={group.threads.length}
                />
                <View
                  className="overflow-hidden rounded-[20px] bg-card"
                  style={{ borderCurve: "continuous" }}
                >
                  {visibleThreads.map((thread, i) => {
                    const threadKey = `${thread.environmentId}:${thread.id}`;
                    return (
                      <Animated.View
                        key={threadKey}
                        collapsable={false}
                        exiting={threadRowExit}
                        layout={THREAD_LAYOUT_TRANSITION}
                        style={{ overflow: "hidden" }}
                      >
                        <ThreadRow
                          thread={thread}
                          environmentLabel={
                            props.savedConnectionsById[thread.environmentId]?.environmentLabel ??
                            null
                          }
                          isLast={i === visibleThreads.length - 1}
                          onArchive={() => props.onArchiveThread(thread)}
                          onDelete={() => props.onDeleteThread(thread)}
                          onPress={() => props.onSelectThread(thread)}
                          onSwipeableClose={handleSwipeableClose}
                          onSwipeableWillOpen={handleSwipeableWillOpen}
                        />
                      </Animated.View>
                    );
                  })}
                </View>
              </Animated.View>
            );
          })
        )}
      </ScrollView>
      {shouldShowConnectionStatus ? (
        <View
          className="absolute left-0 right-0 items-center"
          style={{ bottom: Math.max(insets.bottom, 18) + 76 }}
        >
          <StaleCatalogStatusPill
            catalogState={props.catalogState}
            onPress={props.onOpenEnvironments}
          />
        </View>
      ) : null}
    </View>
  );
}
