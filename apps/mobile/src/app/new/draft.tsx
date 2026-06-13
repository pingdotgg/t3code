import { Stack, useLocalSearchParams } from "expo-router";

import { NewTaskDraftScreen } from "../../features/threads/NewTaskDraftScreen";

export default function NewTaskDraftRoute() {
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    projectId?: string | string[];
    title?: string | string[];
  }>();

  return (
    <>
      <Stack.Screen
        options={{
          title: Array.isArray(params.title) ? params.title[0] : (params.title ?? "New task"),
        }}
      />
      <NewTaskDraftScreen
        initialProjectRef={{
          environmentId: Array.isArray(params.environmentId)
            ? params.environmentId[0]
            : params.environmentId,
          projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
        }}
      />
    </>
  );
}
