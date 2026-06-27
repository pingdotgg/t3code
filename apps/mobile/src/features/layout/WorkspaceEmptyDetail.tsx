import { SymbolView } from "expo-symbols";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

export function WorkspaceEmptyDetail() {
  const iconColor = useThemeColor("--color-icon-subtle");

  return (
    <View className="flex-1 items-center justify-center bg-screen px-10">
      <View className="max-w-[360px] items-center gap-3">
        <SymbolView name="sidebar.left" size={34} tintColor={iconColor} type="hierarchical" />
        <Text className="text-center text-xl font-t3-bold">Select a thread</Text>
        <Text className="text-center text-base text-foreground-muted">
          Choose a thread from the sidebar or start a new task.
        </Text>
      </View>
    </View>
  );
}
