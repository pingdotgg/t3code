import { SymbolView } from "../../components/AppSymbol";
import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

export function WorkspaceEmptyDetail(props: {
  readonly onStartNewTask?: () => void;
  readonly onToggleSidebar?: () => void;
  readonly primarySidebarVisible?: boolean;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 items-center justify-center bg-screen px-10">
      {props.onToggleSidebar ? (
        <View className="absolute right-3" style={{ top: Math.max(insets.top, 12) }}>
          <AndroidHeaderIconButton
            accessibilityLabel={
              props.primarySidebarVisible ? "Hide thread sidebar" : "Show thread sidebar"
            }
            icon={
              props.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
            }
            onPress={props.onToggleSidebar}
          />
        </View>
      ) : null}
      <View className="max-w-[360px] items-center gap-3">
        <SymbolView name="sidebar.left" size={34} tintColor={iconColor} type="hierarchical" />
        <Text className="text-center text-xl font-t3-bold">Select a thread</Text>
        <Text className="text-center text-base text-foreground-muted">
          Choose a thread from the sidebar or start a new task.
        </Text>
        {props.onStartNewTask ? (
          <Pressable
            accessibilityRole="button"
            className="mt-2 flex-row items-center gap-2 rounded-full bg-primary px-5 py-3 active:opacity-70"
            onPress={props.onStartNewTask}
          >
            <Text className="text-base font-t3-bold text-primary-foreground">New Task</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
