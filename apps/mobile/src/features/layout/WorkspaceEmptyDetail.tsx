import { SymbolView } from "../../components/AppSymbol";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

export function WorkspaceEmptyDetail(props: {
  readonly onStartNewTask?: () => void;
  /**
   * Passed only while the sidebar is hidden and this route's header has no
   * toggle of its own — otherwise the pane points at a sidebar that is not on
   * screen and cannot be brought back.
   */
  readonly onShowSidebar?: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");

  return (
    <View className="flex-1 items-center justify-center bg-screen px-10">
      <View className="max-w-[360px] items-center gap-3">
        <SymbolView name="sidebar.left" size={34} tintColor={iconColor} type="hierarchical" />
        <Text className="text-center text-xl font-t3-bold">Select a thread</Text>
        {/* Deliberately does not name the sidebar: this pane also renders when
            the sidebar is hidden. Mirrors the web empty state. */}
        <Text className="text-center text-base text-foreground-muted">
          Select an existing thread or start a new task.
        </Text>
        <View className="mt-2 flex-row flex-wrap items-center justify-center gap-2">
          {props.onShowSidebar ? (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-2 rounded-full bg-subtle px-5 py-3 active:opacity-70"
              onPress={props.onShowSidebar}
            >
              <Text className="text-base font-t3-bold text-foreground">Show sidebar</Text>
            </Pressable>
          ) : null}
          {props.onStartNewTask ? (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
              onPress={props.onStartNewTask}
            >
              <Text className="text-base font-t3-bold text-primary-foreground">New Task</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}
