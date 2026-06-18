import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { threadStatusTone } from "../threads/threadPresentation";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  readonly onAddConnection: () => void;
  readonly onOpenEnvironments: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}

interface ProjectGroup {
  readonly key: string;
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

const projectGroupActivityOrder = Order.mapInput(
  Order.Struct({
    activityAt: Order.flip(Order.Number),
  }),
  (group: ProjectGroup) => ({
    activityAt: new Date(group.threads[0]!.updatedAt ?? group.threads[0]!.createdAt).getTime(),
  }),
);

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
        className="flex-1 text-[12px] font-t3-medium uppercase text-foreground-muted"
        style={{ letterSpacing: 0.5 }}
        numberOfLines={1}
      >
        {props.project.title}
      </Text>

      {hiddenCount > 0 ? (
        <Pressable onPress={props.onToggleExpand} hitSlop={8}>
          <Text
            className="text-[12px] font-t3-medium text-foreground-muted"
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
  readonly isLast: boolean;
}) {
  const separatorColor = useThemeColor("--color-separator");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const { bg, fg } = statusColors(props.thread);
  const tone = threadStatusTone(props.thread);
  const timestamp = relativeTime(props.thread.updatedAt ?? props.thread.createdAt);
  const branch = props.thread.branch;
  const subtitleParts = [props.environmentLabel, branch].filter((part): part is string =>
    Boolean(part),
  );

  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
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
        {/* Git status indicator */}
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

        {/* Content */}
        <View style={{ flex: 1, gap: 3 }}>
          {/* Title + Status + Timestamp */}
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className="flex-1 text-[15px] font-t3-bold leading-[20px] text-foreground"
              numberOfLines={1}
            >
              {props.thread.title}
            </Text>
            <View className="flex-row items-center gap-2">
              <View
                className={tone.pillClassName}
                style={{ borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2 }}
              >
                <Text className={`text-[10px] font-t3-bold ${tone.textClassName}`}>
                  {tone.label}
                </Text>
              </View>
              <Text
                className="text-[12px] text-foreground-tertiary"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {timestamp}
              </Text>
            </View>
          </View>

          {/* Environment + branch */}
          {subtitleParts.length > 0 ? (
            <View className="flex-row items-center gap-1.5" style={{ marginTop: 1 }}>
              <SymbolView
                name="arrow.triangle.branch"
                size={10}
                tintColor={iconSubtleColor}
                type="monochrome"
              />
              <Text
                className="text-[11px] text-foreground-tertiary"
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
      <Text className="max-w-[260px] text-[13px] font-t3-bold text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function HomeScreen(props: HomeScreenProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
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

  /* Build project title lookup for search */
  const projectTitleByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of props.projects) {
      map.set(scopedProjectKey(p.environmentId, p.id), p.title);
    }
    return map;
  }, [props.projects]);

  /* Filter threads by search query */
  const filteredThreads = useMemo(() => {
    const q = props.searchQuery.trim().toLowerCase();
    if (!q) return props.threads;
    return props.threads.filter((t) => {
      if (t.title.toLowerCase().includes(q)) return true;
      const key = scopedProjectKey(t.environmentId, t.projectId);
      return projectTitleByKey.get(key)?.toLowerCase().includes(q) ?? false;
    });
  }, [props.threads, props.searchQuery, projectTitleByKey]);

  /* Group filtered threads by project */
  const projectGroups = useMemo<ReadonlyArray<ProjectGroup>>(() => {
    const byProject = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of filteredThreads) {
      const key = scopedProjectKey(thread.environmentId, thread.projectId);
      const existing = byProject.get(key);
      if (existing) existing.push(thread);
      else byProject.set(key, [thread]);
    }

    const groups: ProjectGroup[] = [];
    for (const project of props.projects) {
      const key = scopedProjectKey(project.environmentId, project.id);
      const threads = byProject.get(key);
      if (threads && threads.length > 0) {
        groups.push({ key, project, threads });
      }
    }

    return Arr.sort(groups, projectGroupActivityOrder);
  }, [props.projects, filteredThreads]);

  /* Empty states */
  const hasAnyThreads = props.threads.length > 0;
  const hasResults = filteredThreads.length > 0;
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
        ) : !hasResults ? (
          <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
        ) : (
          projectGroups.map((group) => {
            const isExpanded = expandedProjects.has(group.key);
            const visibleThreads = isExpanded
              ? group.threads
              : group.threads.slice(0, COLLAPSED_THREAD_LIMIT);

            return (
              <View key={group.key}>
                <ProjectGroupLabel
                  project={group.project}
                  totalThreadCount={group.threads.length}
                  isExpanded={isExpanded}
                  onToggleExpand={() => toggleExpanded(group.key)}
                />
                <View
                  className="overflow-hidden rounded-[20px] bg-card"
                  style={{ borderCurve: "continuous" }}
                >
                  {visibleThreads.map((thread, i) => (
                    <ThreadRow
                      key={`${thread.environmentId}:${thread.id}`}
                      thread={thread}
                      environmentLabel={
                        props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null
                      }
                      onPress={() => props.onSelectThread(thread)}
                      isLast={i === visibleThreads.length - 1}
                    />
                  ))}
                </View>
              </View>
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
