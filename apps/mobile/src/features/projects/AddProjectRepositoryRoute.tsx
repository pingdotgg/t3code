import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { addProjectRemoteTargetLabel } from "@t3tools/client-runtime/operations/projects";

import { AddProjectRepositoryScreen } from "./AddProjectScreen";

type AddProjectRepositoryRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
  readonly host?: string | string[];
};

export function AddProjectRepositoryRoute({
  route,
}: StaticScreenProps<AddProjectRepositoryRouteParams>) {
  const params = route.params ?? {};
  const source = Array.isArray(params.source) ? params.source[0] : params.source;
  const host = Array.isArray(params.host) ? params.host[0] : params.host;
  const title =
    source === "github" ||
    source === "github-enterprise" ||
    source === "gitlab" ||
    source === "bitbucket" ||
    source === "azure-devops"
      ? addProjectRemoteTargetLabel({ id: source, source, host: host ?? null })
      : "Git URL";

  return (
    <>
      <NativeStackScreenOptions options={{ title }} />
      <AddProjectRepositoryScreen {...params} />
    </>
  );
}
