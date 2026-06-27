import Stack from "expo-router/stack";
import { Platform, StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";
import { useAdaptiveWorkspaceLayout } from "../../../../features/layout/AdaptiveWorkspaceLayout";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { ThreadSelectionProvider } from "../../../../state/use-thread-selection";

export default function ThreadLayout() {
  const { fileInspector } = useAdaptiveWorkspaceLayout();
  const sheetStyle = StyleSheet.flatten(useResolveClassNames("bg-sheet"));
  const headerTintColor = useThemeColor("--color-foreground");
  const headerBg = {
    backgroundColor: (sheetStyle as { backgroundColor?: string })?.backgroundColor,
  };

  return (
    <ThreadSelectionProvider>
      <Stack screenOptions={{ headerShown: false, headerTintColor }}>
        <Stack.Screen
          name="index"
          options={{
            contentStyle: { backgroundColor: "transparent" },
            headerShown: true,
            headerTransparent: true,
            headerTitle: "",
          }}
        />
        <Stack.Screen
          name="git"
          options={{
            contentStyle: sheetStyle,
            gestureEnabled: true,
            headerShown: false,
            presentation: "formSheet" as const,
            sheetAllowedDetents: [0.85],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="git-confirm"
          options={{
            contentStyle: sheetStyle,
            gestureEnabled: true,
            headerShown: false,
            presentation: "formSheet" as const,
            sheetAllowedDetents: [0.4],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="review"
          options={{
            animation: "slide_from_right",
            contentStyle: sheetStyle,
            headerBackButtonDisplayMode: "minimal",
            headerShown: true,
            headerTitle: "Files changed",
            headerBackTitle: "",
            headerShadowVisible: false,
            headerStyle: headerBg,
          }}
        />
        <Stack.Screen
          name="files/index"
          options={{
            animation: fileInspector.supported ? "none" : "slide_from_right",
            contentStyle: sheetStyle,
            gestureEnabled: true,
            headerBackButtonDisplayMode: "minimal",
            headerShown: true,
            headerTitle: "Files",
            headerBackTitle: "",
            headerShadowVisible: false,
            headerStyle: headerBg,
          }}
        />
        <Stack.Screen
          name="files/[...path]"
          options={{
            animation: fileInspector.supported ? "none" : "slide_from_right",
            contentStyle: sheetStyle,
            gestureEnabled: true,
            headerBackButtonDisplayMode: "minimal",
            headerShown: true,
            headerTitle: "File",
            headerBackTitle: "",
            headerShadowVisible: false,
            headerStyle: headerBg,
          }}
        />
        <Stack.Screen
          name="review-comment"
          options={{
            contentStyle: sheetStyle,
            gestureEnabled: true,
            headerShown: false,
            presentation: Platform.OS === "android" ? "fullScreenModal" : "formSheet",
            sheetAllowedDetents: Platform.OS === "android" ? undefined : [0.72, 0.92],
            sheetGrabberVisible: Platform.OS !== "android",
          }}
        />
        <Stack.Screen
          name="terminal"
          options={{
            animation: "slide_from_right",
            contentStyle: { backgroundColor: "#050505" },
            headerBackButtonDisplayMode: "minimal",
            headerShown: true,
            headerShadowVisible: false,
          }}
        />
      </Stack>
    </ThreadSelectionProvider>
  );
}
