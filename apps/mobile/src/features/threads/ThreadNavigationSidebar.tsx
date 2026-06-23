import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { StatusPill } from "../../components/StatusPill";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useThreadShells } from "../../state/entities";
import { buildThreadNavigationGroups } from "./thread-navigation-groups";
import { threadStatusTone } from "./threadPresentation";

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
  const groups = useMemo(
    () => buildThreadNavigationGroups({ projects, threads, searchQuery }),
    [projects, searchQuery, threads],
  );

  const backgroundColor = useThemeColor("--color-drawer");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon-muted");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const searchBackgroundColor = useThemeColor("--color-subtle-strong");
  const selectedBackgroundColor = useThemeColor("--color-subtle-strong");
  const pressedBackgroundColor = useThemeColor("--color-subtle");

  return (
    <View
      testID="thread-navigation-sidebar"
      style={{
        width: props.width,
        backgroundColor,
        borderRightColor: borderColor,
        borderRightWidth: StyleSheet.hairlineWidth,
        paddingTop: insets.top + 8,
      }}
    >
      <View style={styles.header}>
        <Text className="flex-1 text-2xl font-t3-bold" numberOfLines={1}>
          Threads
        </Text>
        <Pressable
          accessibilityLabel="Open settings"
          accessibilityRole="button"
          hitSlop={4}
          onPress={props.onOpenSettings}
          style={({ pressed }) => [
            styles.headerButton,
            { backgroundColor: pressed ? pressedBackgroundColor : "transparent" },
          ]}
        >
          <SymbolView name="gearshape" size={18} tintColor={iconColor} type="monochrome" />
        </Pressable>
        <Pressable
          accessibilityLabel="New task"
          accessibilityRole="button"
          hitSlop={4}
          onPress={props.onStartNewTask}
          style={({ pressed }) => [
            styles.headerButton,
            { backgroundColor: pressed ? pressedBackgroundColor : "transparent" },
          ]}
        >
          <SymbolView name="square.and.pencil" size={18} tintColor={iconColor} type="monochrome" />
        </Pressable>
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

      <ScrollView
        contentContainerStyle={{
          gap: 18,
          paddingHorizontal: 10,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 16),
        }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
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
                    <Pressable
                      key={threadKey}
                      accessibilityLabel={thread.title}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => props.onSelectThread(thread)}
                      style={({ pressed }) => [
                        styles.threadRow,
                        {
                          backgroundColor: selected
                            ? selectedBackgroundColor
                            : pressed
                              ? pressedBackgroundColor
                              : "transparent",
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
                  );
                })
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 48,
    paddingLeft: 18,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
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
  threadText: {
    minWidth: 0,
    flex: 1,
    gap: 2,
  },
});
