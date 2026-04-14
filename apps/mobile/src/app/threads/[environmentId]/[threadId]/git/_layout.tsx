import Stack from "expo-router/stack";
import { StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

export const unstable_settings = {
  anchor: "index",
};

export default function GitSheetLayout() {
  const sheetStyle = StyleSheet.flatten(useResolveClassNames("bg-sheet"));
  const headerBg = {
    backgroundColor: (sheetStyle as { backgroundColor?: string })?.backgroundColor,
  };

  return (
    <Stack
      screenOptions={{
        contentStyle: sheetStyle,
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" options={{ animation: "none" }} />
      <Stack.Screen
        name="commit"
        options={{
          animation: "slide_from_right",
          headerShown: true,
          headerTitle: "Commit changes",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="branches"
        options={{
          animation: "slide_from_right",
          headerShown: true,
          headerTitle: "Branches & worktrees",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
      <Stack.Screen
        name="review"
        options={{
          animation: "slide_from_right",
          headerShown: true,
          headerTitle: "Review changes",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: headerBg,
        }}
      />
    </Stack>
  );
}
