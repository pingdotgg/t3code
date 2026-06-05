import { Stack, useLocalSearchParams } from "expo-router";
import { addProjectRemoteSourceLabel } from "@t3tools/client-runtime";

import { AddProjectRepositoryScreen } from "../../../features/projects/AddProjectScreen";

export default function AddProjectRepositoryRoute() {
  const params = useLocalSearchParams<{ source?: string | string[] }>();
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const title =
    source === "github" ||
    source === "gitlab" ||
    source === "bitbucket" ||
    source === "azure-devops"
      ? addProjectRemoteSourceLabel(source)
      : "Git URL";

  return (
    <>
      <Stack.Screen options={{ title }} />
      <AddProjectRepositoryScreen />
    </>
  );
}
