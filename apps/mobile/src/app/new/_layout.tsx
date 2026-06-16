import Stack from "expo-router/stack";
import { useResolveClassNames } from "uniwind";

import { NewTaskFlowProvider } from "../../features/threads/new-task-flow-provider";
import { useThemeColor } from "../../lib/useThemeColor";

export const unstable_settings = {
  anchor: "index",
};

export default function NewTaskLayout() {
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
