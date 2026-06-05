import Stack from "expo-router/stack";
import { useColorScheme } from "react-native";
import { useResolveClassNames } from "uniwind";

import { NewTaskFlowProvider } from "../../features/threads/new-task-flow-provider";

export const unstable_settings = {
  anchor: "index",
};

export default function NewTaskLayout() {
  const sheetStyle = useResolveClassNames("bg-sheet");
  const isDark = useColorScheme() === "dark";
  const sheetBg = isDark ? "rgba(14, 14, 14, 0.98)" : "rgba(242, 242, 247, 0.98)";
  const headerTint = isDark ? "#f5f5f5" : "#262626";

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
