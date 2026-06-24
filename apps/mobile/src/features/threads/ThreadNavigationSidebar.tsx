import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ColorValue } from "react-native";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { useThreadListActions } from "../home/useThreadListActions";
import { buildThreadNavigationGroups } from "./thread-navigation-groups";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { threadStatusTone } from "./threadPresentation";

const ThreadNavigationRow = memo(function ThreadNavigationRow(props: {
  readonly backgroundColor: ColorValue;
  readonly fullSwipeWidth: number;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly pressedBackgroundColor: ColorValue;
  readonly selected: boolean;
  readonly selectedBackgroundColor: ColorValue;
  readonly thread: EnvironmentThreadShell;
}) {
  const {
    backgroundColor,
    fullSwipeWidth,
    onArchiveThread,
    onDeleteThread,
    onSelectThread,
    onSwipeableClose,
    onSwipeableWillOpen,
    pressedBackgroundColor,
    selected,
    selectedBackgroundColor,
    thread,
  } = props;
  const handleArchive = useCallback(() => {
    onArchiveThread(thread);
  }, [onArchiveThread, thread]);
  const handleDelete = useCallback(() => {
    onDeleteThread(thread);
  }, [onDeleteThread, thread]);
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );

  return (
    <ThreadSwipeable
      backgroundColor={backgroundColor}
      containerStyle={styles.threadRowContainer}
      fullSwipeWidth={fullSwipeWidth}
      onDelete={handleDelete}
      onSwipeableClose={onSwipeableClose}
      onSwipeableWillOpen={onSwipeableWillOpen}
      primaryAction={primaryAction}
      threadTitle={thread.title}
    >
      {(close) => (
        <Pressable
          accessibilityHint="Swipe left for archive and delete actions"
          accessibilityLabel={thread.title}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          onPress={() => {
            close();
            onSelectThread(thread);
          }}
          style={({ pressed }) => [
            styles.threadRow,
            {
              backgroundColor: selected
                ? selectedBackgroundColor
                : pressed
                  ? pressedBackgroundColor
                  : backgroundColor,
            },
          ]}
        >
          <View style={styles.threadText}>
            <Text className="text-base font-t3-medium" numberOfLines={1}>
              {thread.title}
            </Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {relativeTime(thread.updatedAt ?? thread.createdAt)}
            </Text>
          </View>
          <StatusPill {...threadStatusTone(thread)} size="compact" />
        </Pressable>
      )}
    </ThreadSwipeable>
  );
});

export function ThreadNavigationSidebar(props: {
  readonly width: number;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onStartNewTask: () => void;
}) {
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const threads = useThreadShells();
  const [searchQuery, setSearchQuery] = useState("");
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const { archiveThread, confirmDeleteThread } = useThreadListActions();
  const groups = useMemo(
    () => buildThreadNavigationGroups({ projects, threads, searchQuery }),
    [projects, searchQuery, threads],
  );

  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const searchBackgroundColor = useThemeColor("--color-subtle-strong");
  const selectedBackgroundColor = useThemeColor("--color-subtle-strong");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
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

  return (
    <View
      testID="thread-navigation-sidebar"
      style={[
        styles.container,
        {
          width: props.width,
          backgroundColor,
          borderRightColor: borderColor,
          borderRightWidth: StyleSheet.hairlineWidth,
          paddingTop: insets.top,
        },
      ]}
    >
      <View style={styles.header}>
        <Text className="flex-1 text-2xl font-t3-bold" numberOfLines={1}>
          Threads
        </Text>
        <SidebarHeaderActions
          onOpenSettings={props.onOpenSettings}
          onStartNewTask={props.onStartNewTask}
        />
      </View>

      <View style={[styles.searchField, { backgroundColor: searchBackgroundColor }]}>
        <SymbolView name="magnifyingglass" size={15} tintColor={mutedColor} type="monochrome" />
        <TextInput
          accessibilityLabel="Search threads"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={setSearchQuery}
          placeholder="Search"
          placeholderTextColor={placeholderColor}
          returnKeyType="search"
          style={[styles.searchInput, { color: foregroundColor }]}
          value={searchQuery}
        />
      </View>

      <View style={{ flex: 1, paddingBottom: insets.bottom }}>
        <ScrollView
          contentContainerStyle={styles.threadListContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => openSwipeableRef.current?.close()}
          showsVerticalScrollIndicator={false}
          style={styles.threadList}
        >
          {groups.length === 0 ? (
            <Text className="px-2 py-4 text-sm text-foreground-muted">
              {searchQuery.trim().length > 0 ? "No matching threads" : "No threads yet"}
            </Text>
          ) : (
            groups.map((group) => (
              <View key={group.key} style={styles.section}>
                <Text className="px-2 text-xs font-t3-bold text-foreground-muted" numberOfLines={1}>
                  {group.title}
                </Text>

                {group.threads.length === 0 ? (
                  <Text className="px-2 py-2 text-sm text-foreground-tertiary">No threads yet</Text>
                ) : (
                  group.threads.map((thread) => {
                    const threadKey = scopedThreadKey(thread.environmentId, thread.id);
                    const selected = threadKey === props.selectedThreadKey;

                    return (
                      <ThreadNavigationRow
                        key={threadKey}
                        backgroundColor={backgroundColor}
                        fullSwipeWidth={props.width - 20}
                        onArchiveThread={archiveThread}
                        onDeleteThread={confirmDeleteThread}
                        onSelectThread={props.onSelectThread}
                        onSwipeableClose={handleSwipeableClose}
                        onSwipeableWillOpen={handleSwipeableWillOpen}
                        pressedBackgroundColor={pressedBackgroundColor}
                        selected={selected}
                        selectedBackgroundColor={selectedBackgroundColor}
                        thread={thread}
                      />
                    );
                  })
                )}
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    height: 44,
    paddingLeft: 18,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  searchField: {
    height: 36,
    marginTop: 6,
    marginHorizontal: 14,
    paddingLeft: 10,
    paddingRight: 5,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  searchInput: {
    flex: 1,
    height: 36,
    paddingVertical: 0,
    paddingHorizontal: 0,
    fontFamily: "DMSans_400Regular",
    fontSize: 15,
  },
  threadList: {
    flex: 1,
  },
  threadListContent: {
    gap: 18,
    paddingHorizontal: 10,
    paddingTop: 16,
    paddingBottom: 16,
  },
  section: {
    gap: 4,
  },
  threadRow: {
    minHeight: 58,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  threadRowContainer: {
    borderRadius: 10,
    overflow: "hidden",
  },
  threadText: {
    minWidth: 0,
    flex: 1,
    gap: 2,
  },
});
