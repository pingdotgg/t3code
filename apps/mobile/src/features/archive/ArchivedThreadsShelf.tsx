import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { ActivityIndicator, Pressable, useColorScheme, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import { ArchivedThreadProjectLabel, ArchivedThreadRow } from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadGroup } from "./archivedThreadList";
import { useArchivedThreadSnapshots } from "./useArchivedThreadSnapshots";

const INLINE_ARCHIVED_THREAD_LIMIT = 10;
const ARCHIVE_ACCENT_LIGHT = "#475569";
const ARCHIVE_ACCENT_DARK = "#cbd5e1";

export interface ArchivedThreadsShelfEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface ArchivedThreadsShelfData {
  readonly environmentLabelsById: ReadonlyMap<EnvironmentId, string>;
  readonly error: string | null;
  readonly groups: ReadonlyArray<ArchivedThreadGroup>;
  readonly hasAnyArchivedThreads: boolean;
  readonly isLoading: boolean;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onRestoreThread: (thread: EnvironmentThreadShell) => void;
  readonly refresh: () => void;
  readonly threadCount: number;
}

export function useArchivedThreadsShelfData(input: {
  readonly environments: ReadonlyArray<ArchivedThreadsShelfEnvironment>;
  readonly environmentId: EnvironmentId | null;
  readonly projectKeys: ReadonlySet<string> | null;
  readonly searchQuery: string;
}): ArchivedThreadsShelfData {
  const environmentIds = useMemo(
    () => input.environments.map((environment) => environment.environmentId),
    [input.environments],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        input.environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [input.environments],
  );
  const environmentLabelsById = useMemo(
    () =>
      new Map(
        input.environments.map(
          (environment) => [environment.environmentId, environment.label] as const,
        ),
      ),
    [input.environments],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const hasAnyArchivedThreads = useMemo(
    () =>
      snapshots.some((entry) =>
        entry.snapshot.threads.some((thread) => thread.archivedAt !== null),
      ),
    [snapshots],
  );
  const groups = useMemo(
    () =>
      buildArchivedThreadGroups({
        snapshots,
        environmentLabels,
        environmentId: input.environmentId,
        projectKeys: input.projectKeys,
        searchQuery: input.searchQuery,
        sortOrder: "newest",
      }),
    [environmentLabels, input.environmentId, input.projectKeys, input.searchQuery, snapshots],
  );
  const threadCount = useMemo(
    () => groups.reduce((count, group) => count + group.threads.length, 0),
    [groups],
  );
  const handleCompleted = useCallback(() => undefined, []);
  const { confirmDeleteThread, unarchiveThread } = useArchivedThreadListActions(handleCompleted);

  return {
    environmentLabelsById,
    error,
    groups,
    hasAnyArchivedThreads,
    isLoading,
    onDeleteThread: confirmDeleteThread,
    onRestoreThread: unarchiveThread,
    refresh,
    threadCount,
  };
}

function limitArchivedThreadGroups(
  groups: ReadonlyArray<ArchivedThreadGroup>,
  limit: number,
): ReadonlyArray<ArchivedThreadGroup> {
  let remaining = limit;
  const visibleGroups: ArchivedThreadGroup[] = [];
  for (const group of groups) {
    if (remaining === 0) break;
    const threads = group.threads.slice(0, remaining);
    if (threads.length > 0) {
      visibleGroups.push({ ...group, threads });
      remaining -= threads.length;
    }
  }
  return visibleGroups;
}

export function ArchivedThreadsShelf(props: {
  readonly data: ArchivedThreadsShelfData;
  readonly fullSwipeWidth?: number;
  readonly onOpenArchive: () => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly pane?: "screen" | "sidebar";
  readonly searchQuery: string;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const [expanded, setExpanded] = useState(false);
  const colorScheme = useColorScheme();
  const mutedColor = useThemeColor("--color-foreground-muted");
  const searchActive = props.searchQuery.trim().length > 0;
  useEffect(() => {
    if (searchActive) setExpanded(true);
  }, [searchActive]);
  const visibleGroups = useMemo(
    () => limitArchivedThreadGroups(props.data.groups, INLINE_ARCHIVED_THREAD_LIMIT),
    [props.data.groups],
  );
  const visibleThreadCount = useMemo(
    () => visibleGroups.reduce((count, group) => count + group.threads.length, 0),
    [visibleGroups],
  );
  const hiddenThreadCount = props.data.threadCount - visibleThreadCount;

  if (props.data.threadCount === 0) {
    if (props.data.error === null || props.data.isLoading) return null;
    return (
      <Pressable
        accessibilityLabel="Archive unavailable. Retry loading archived threads."
        accessibilityRole="button"
        className={cn(
          "mt-4 flex-row items-center gap-2.5 pb-2",
          props.pane === "sidebar" ? "px-3" : "px-5",
        )}
        onPress={props.data.refresh}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView name="exclamationmark.triangle" size={12} tintColor={mutedColor} />
        <Text className="text-xs font-t3-medium text-foreground-muted">
          Archive unavailable · Retry
        </Text>
      </Pressable>
    );
  }

  return (
    <View className="pb-2">
      <Pressable
        accessibilityHint={
          expanded ? "Collapses the archived threads." : "Expands the archived threads."
        }
        accessibilityLabel={
          props.data.threadCount === 1
            ? "1 archived thread"
            : `${props.data.threadCount} archived threads`
        }
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className={cn(
          "mt-4 flex-row items-center gap-2.5 pb-1.5",
          props.pane === "sidebar" ? "px-3" : "px-5",
        )}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="archivebox.fill"
          size={12}
          tintColor={colorScheme === "dark" ? ARCHIVE_ACCENT_DARK : ARCHIVE_ACCENT_LIGHT}
          type="monochrome"
        />
        <Text className="text-xs font-t3-medium text-foreground-muted">
          Archived ({props.data.threadCount})
        </Text>
        <View className="h-px flex-1 bg-border" />
        {props.data.isLoading ? (
          <ActivityIndicator color={String(mutedColor)} size="small" />
        ) : (
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={10}
            tintColor={mutedColor}
            type="monochrome"
          />
        )}
      </Pressable>

      {expanded ? (
        <View className={props.pane === "sidebar" ? "px-1" : "px-4"}>
          {props.data.error ? (
            <Pressable
              accessibilityRole="button"
              className="py-2"
              onPress={props.data.refresh}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs text-danger-foreground">
                Some archived threads could not be loaded. Tap to retry.
              </Text>
            </Pressable>
          ) : null}

          {visibleGroups.map((group) => {
            const environmentLabel =
              props.data.environmentLabelsById.get(group.project.environmentId) ?? null;
            return (
              <View className="pt-3" key={group.key}>
                <ArchivedThreadProjectLabel
                  environmentLabel={environmentLabel}
                  project={group.project}
                />
                {group.threads.map((thread, index) => (
                  <ArchivedThreadRow
                    environmentLabel={environmentLabel}
                    fullSwipeWidth={props.fullSwipeWidth}
                    isFirst={index === 0}
                    isLast={index === group.threads.length - 1}
                    key={`${thread.environmentId}:${thread.id}`}
                    onDelete={() => props.data.onDeleteThread(thread)}
                    onUnarchive={() => props.data.onRestoreThread(thread)}
                    onSwipeableClose={props.onSwipeableClose}
                    onSwipeableWillOpen={props.onSwipeableWillOpen}
                    simultaneousSwipeGesture={props.simultaneousSwipeGesture}
                    thread={thread}
                  />
                ))}
              </View>
            );
          })}

          {hiddenThreadCount > 0 ? (
            <Pressable
              accessibilityLabel={`View all ${props.data.threadCount} archived threads`}
              accessibilityRole="button"
              className="mt-3 items-center rounded-lg border border-dashed border-border py-2.5"
              onPress={props.onOpenArchive}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                View all ({hiddenThreadCount} more)
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
