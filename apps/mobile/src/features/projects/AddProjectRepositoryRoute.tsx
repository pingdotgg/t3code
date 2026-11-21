import type { StaticScreenProps } from "@react-navigation/native";

import { AddProjectRepositoryScreen } from "./AddProjectScreen";

type AddProjectRepositoryRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
};

export function AddProjectRepositoryRoute({
  route,
}: StaticScreenProps<AddProjectRepositoryRouteParams>) {
  return <AddProjectRepositoryScreen {...(route.params ?? {})} />;
}
