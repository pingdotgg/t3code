import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation } from "./AndroidWorkspaceNavigation";

/** Settings keeps its existing stack inside the full workspace, above compact navigation. */
export function AndroidWorkspaceSettings(props: { readonly children: ReactNode }) {
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  if (Platform.OS !== "android") return props.children;
  return (
    <View className="flex-1 bg-header">
      <SafeAreaInsetsContext value={layout.usesSplitView ? insets : { ...insets, bottom: 0 }}>
        <View className="flex-1">{props.children}</View>
      </SafeAreaInsetsContext>
      {layout.usesSplitView ? null : <AndroidWorkspaceNavigation onNewThread={startNewTask} />}
    </View>
  );
}
