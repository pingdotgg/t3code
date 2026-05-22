import { Stack, useLocalSearchParams } from "expo-router";

import { NewTaskDraftScreen } from "../../features/threads/NewTaskDraftScreen";

export default function NewTaskDraftRoute() {
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    projectId?: string | string[];
  }>();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
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
