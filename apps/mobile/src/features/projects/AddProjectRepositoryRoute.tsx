import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { addProjectRemoteSourceLabel } from "@t3tools/client-runtime/operations/projects";

import { AddProjectRepositoryScreen } from "./AddProjectScreen";

type AddProjectRepositoryRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
};

export function AddProjectRepositoryRoute({
  route,
}: StaticScreenProps<AddProjectRepositoryRouteParams>) {
  const params = route.params ?? {};
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
      <NativeStackScreenOptions options={{ title }} />
      <AddProjectRepositoryScreen {...params} />
    </>
  );
}
