import { useRouter } from "expo-router";
import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import { Pressable } from "react-native";
import { useResolveClassNames } from "uniwind";

import { useAdaptiveWorkspaceLayout } from "../../features/layout/AdaptiveWorkspaceLayout";
import { NewTaskFlowProvider } from "../../features/threads/new-task-flow-provider";
import { useThemeColor } from "../../lib/useThemeColor";

export const unstable_settings = {
  anchor: "index",
};

function NewTaskCloseButton() {
  const router = useRouter();
  const tintColor = useThemeColor("--color-foreground");

  return (
    <Pressable
      accessibilityLabel="Close new task"
      accessibilityRole="button"
      className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
      hitSlop={8}
      onPress={() => router.dismiss()}
    >
      <SymbolView name="xmark" size={14} tintColor={String(tintColor)} type="monochrome" />
    </Pressable>
  );
}

export default function NewTaskLayout() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const sheetStyle = useResolveClassNames("bg-sheet");
  const sheetBg = useThemeColor("--color-sheet");
  const headerTint = useThemeColor("--color-foreground");

  return (
    <NewTaskFlowProvider>
      <Stack
        screenOptions={{
          contentStyle: sheetStyle,
          headerBackButtonDisplayMode: "minimal",
          headerLargeTitle: false,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: sheetBg },
          headerTintColor: headerTint,
          headerTitleStyle: { fontFamily: "DMSans_700Bold" },
          headerRight: layout.usesSplitView ? NewTaskCloseButton : undefined,
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none", title: "Choose project" }} />
        <Stack.Screen
          name="add-project/index"
          options={{ animation: "slide_from_right", title: "New project" }}
        />
        <Stack.Screen
          name="add-project/repository"
          options={{ animation: "slide_from_right", title: "Repository" }}
        />
        <Stack.Screen
          name="add-project/destination"
          options={{ animation: "slide_from_right", title: "Clone destination" }}
        />
        <Stack.Screen
          name="add-project/local"
          options={{ animation: "slide_from_right", title: "Local folder" }}
        />
        <Stack.Screen name="draft" options={{ animation: "slide_from_right", title: "New task" }} />
      </Stack>
    </NewTaskFlowProvider>
  );
}
