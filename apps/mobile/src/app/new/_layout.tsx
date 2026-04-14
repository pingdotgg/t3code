import Stack from "expo-router/stack";
import { useResolveClassNames } from "uniwind";

import { NewTaskFlowProvider } from "../../features/threads/new-task-flow-provider";

export const unstable_settings = {
  anchor: "index",
};

export default function NewTaskLayout() {
  const sheetStyle = useResolveClassNames("bg-sheet");

  return (
    <NewTaskFlowProvider>
      <Stack
        screenOptions={{
          contentStyle: sheetStyle,
        }}
      >
        <Stack.Screen name="index" options={{ animation: "none" }} />
        <Stack.Screen name="draft" options={{ animation: "slide_from_right" }} />
      </Stack>
    </NewTaskFlowProvider>
  );
}
