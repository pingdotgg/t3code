import type {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
  VcsStatusState,
} from "@t3tools/client-runtime";
import { LegendList } from "@legendapp/list/react-native";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import type { RemoteCatalogState } from "../../state/use-remote-catalog";
import { useVcsStatus } from "../../state/use-vcs-status";
import { threadStatusTone } from "../threads/threadPresentation";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentScopedProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
  readonly catalogState: RemoteCatalogState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  readonly onAddConnection: () => void;
  readonly onSelectThread: (thread: EnvironmentScopedThreadShell) => void;
}

interface ProjectGroup {
  readonly key: string;
  readonly project: EnvironmentScopedProjectShell;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
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

function statusColors(thread: EnvironmentScopedThreadShell): { bg: string; fg: string } {
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
  readonly catalogState: RemoteCatalogState;
  readonly projectCount: number;
}): { readonly title: string; readonly detail: string; readonly loading: boolean } {
  const { catalogState } = props;
  if (catalogState.isLoadingSavedConnections) {
    return {
      title: "Loading environments",
      detail: "Checking saved environments on this device.",
      loading: true,
    };
  }

  if (!catalogState.hasSavedConnections) {
    return {
      title: "No environments connected",
      detail: "Add an environment to load projects and start coding sessions.",
      loading: false,
    };
  }

  if (catalogState.connectionState === "disconnected" && !catalogState.hasLoadedShellSnapshot) {
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
  readonly project: EnvironmentScopedProjectShell;
  readonly totalThreadCount: number;
  readonly httpBaseUrl: string | null;
  readonly bearerToken: string | null;
  readonly isExpanded: boolean;
  readonly onToggleExpand: () => void;
}) {
  const hiddenCount = props.totalThreadCount - COLLAPSED_THREAD_LIMIT;

  return (
    <View className="flex-row items-center gap-2.5 px-1 pb-2">
      <ProjectFavicon
        size={18}
        projectTitle={props.project.title}
        httpBaseUrl={props.httpBaseUrl}
        workspaceRoot={props.project.workspaceRoot}
        bearerToken={props.bearerToken}
      />
      <Text
        className="flex-1 text-[13px] font-t3-bold uppercase text-foreground-muted"
        style={{ letterSpacing: 0.6 }}
        numberOfLines={1}
      >
        {props.project.title}
      </Text>

      {hiddenCount > 0 ? (
        <Pressable onPress={props.onToggleExpand} hitSlop={8}>
          <Text
            className="text-[13px] font-t3-bold text-foreground-muted"
            style={{ letterSpacing: 0.6 }}
          >
            {props.isExpanded ? "Show less" : `${hiddenCount} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ─── Git summary line ──────────────────────────────────────────────── */

function gitSummaryParts(gitStatus: VcsStatusState): ReadonlyArray<string> {
  if (!gitStatus.data) return [];
  const { data } = gitStatus;
  const parts: string[] = [];
  if (data.hasWorkingTreeChanges) {
    parts.push(`${data.workingTree.files.length} changed`);
  }
  if (data.aheadCount > 0) parts.push(`${data.aheadCount} ahead`);
  if (data.behindCount > 0) parts.push(`${data.behindCount} behind`);
  if (data.pr?.state === "open") parts.push(`PR #${data.pr.number}`);
  return parts;
}

/* ─── Thread row ─────────────────────────────────────────────────────── */

function ThreadRow(props: {
  readonly thread: EnvironmentScopedThreadShell;
  readonly projectCwd: string | null;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const separatorColor = useThemeColor("--color-separator");
  const { bg, fg } = statusColors(props.thread);
  const tone = threadStatusTone(props.thread);
  const timestamp = relativeTime(props.thread.updatedAt ?? props.thread.createdAt);
  const branch = props.thread.branch;

  // Subscribe to live git status — only when thread has a branch set.
  // Threads sharing the same cwd share one WS subscription via ref-counting.
  const cwd = branch ? (props.thread.worktreePath ?? props.projectCwd) : null;
  const gitStatus = useVcsStatus({
    environmentId: cwd ? props.thread.environmentId : null,
    cwd,
  });
  const gitParts = gitSummaryParts(gitStatus);

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

          {/* Branch + git info */}
          {branch ? (
            <View className="flex-row items-center gap-1.5" style={{ marginTop: 1 }}>
              <SymbolView
                name="arrow.triangle.branch"
                size={10}
                tintColor="#737373"
                type="monochrome"
              />
              <Text
                className="text-[11px] text-foreground-tertiary"
                numberOfLines={1}
                style={{ fontFamily: "monospace" }}
              >
                {branch}
              </Text>
              {gitParts.length > 0 ? (
                <Text className="text-[11px] text-foreground-tertiary">
                  {" · " + gitParts.join(" · ")}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function ProjectGroupCard(props: {
  readonly group: ProjectGroup;
  readonly connection: SavedRemoteConnection | undefined;
  readonly isExpanded: boolean;
  readonly onToggleExpand: (key: string) => void;
  readonly onSelectThread: (thread: EnvironmentScopedThreadShell) => void;
}) {
  const visibleThreads = props.isExpanded
    ? props.group.threads
    : props.group.threads.slice(0, COLLAPSED_THREAD_LIMIT);

  return (
    <View>
      <ProjectGroupLabel
        project={props.group.project}
        totalThreadCount={props.group.threads.length}
        httpBaseUrl={props.connection?.httpBaseUrl ?? null}
        bearerToken={props.connection?.bearerToken ?? null}
        isExpanded={props.isExpanded}
        onToggleExpand={() => props.onToggleExpand(props.group.key)}
      />
      <View
        className="overflow-hidden rounded-[20px] bg-card"
        style={{ borderCurve: "continuous" }}
      >
        {visibleThreads.map((thread, i) => (
          <ThreadRow
            key={`${thread.environmentId}:${thread.id}`}
            thread={thread}
            projectCwd={props.group.project.workspaceRoot}
            onPress={() => props.onSelectThread(thread)}
            isLast={i === visibleThreads.length - 1}
          />
        ))}
      </View>
    </View>
  );
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
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
    const byProject = new Map<string, EnvironmentScopedThreadShell[]>();
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
  const emptyState = deriveEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });
  const renderProjectGroup = useCallback(
    ({ item: group }: { readonly item: ProjectGroup }) => (
      <ProjectGroupCard
        group={group}
        connection={props.savedConnectionsById[group.project.environmentId]}
        isExpanded={expandedProjects.has(group.key)}
        onToggleExpand={toggleExpanded}
        onSelectThread={props.onSelectThread}
      />
    ),
    [expandedProjects, props.onSelectThread, props.savedConnectionsById, toggleExpanded],
  );

  if (hasAnyThreads && hasResults) {
    return (
      <LegendList
        data={projectGroups as ProjectGroup[]}
        renderItem={renderProjectGroup}
        keyExtractor={(group) => group.key}
        estimatedItemSize={360}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-screen"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 24,
          gap: 20,
        }}
      />
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
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
      ) : (
        <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
      )}
    </ScrollView>
  );
}
