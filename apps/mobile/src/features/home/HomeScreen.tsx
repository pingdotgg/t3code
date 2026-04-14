import type {
  EnvironmentScopedProjectShell,
  EnvironmentScopedThreadShell,
  GitStatusState,
} from "@t3tools/client-runtime";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { useGitStatus } from "../../state/use-git-status";
import { threadStatusTone } from "../threads/threadPresentation";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentScopedProjectShell>;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly searchQuery: string;
  readonly onSelectThread: (thread: EnvironmentScopedThreadShell) => void;
}

interface ProjectGroup {
  readonly key: string;
  readonly project: EnvironmentScopedProjectShell;
  readonly threads: ReadonlyArray<EnvironmentScopedThreadShell>;
}

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

function gitSummaryParts(gitStatus: GitStatusState): ReadonlyArray<string> {
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
  const gitStatus = useGitStatus({
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

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());

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

    groups.sort((a, b) => {
      const aTime = new Date(a.threads[0]!.updatedAt ?? a.threads[0]!.createdAt).getTime();
      const bTime = new Date(b.threads[0]!.updatedAt ?? b.threads[0]!.createdAt).getTime();
      return bTime - aTime;
    });

    return groups;
  }, [props.projects, filteredThreads]);

  /* Empty states */
  const hasAnyThreads = props.threads.length > 0;
  const hasResults = filteredThreads.length > 0;

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
        <EmptyState
          title="No threads yet"
          detail="Create a task to start a new coding session in one of your connected projects."
        />
      ) : !hasResults ? (
        <EmptyState title="No results" detail={`No threads matching "${props.searchQuery}".`} />
      ) : (
        projectGroups.map((group) => {
          const connection = props.savedConnectionsById[group.project.environmentId];
          const isExpanded = expandedProjects.has(group.key);
          const visibleThreads = isExpanded
            ? group.threads
            : group.threads.slice(0, COLLAPSED_THREAD_LIMIT);

          return (
            <View key={group.key}>
              <ProjectGroupLabel
                project={group.project}
                totalThreadCount={group.threads.length}
                httpBaseUrl={connection?.httpBaseUrl ?? null}
                bearerToken={connection?.bearerToken ?? null}
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
                    projectCwd={group.project.workspaceRoot}
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
  );
}
