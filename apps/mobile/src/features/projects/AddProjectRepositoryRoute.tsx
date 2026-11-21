import type { StaticScreenProps } from "@react-navigation/native";

import { AddProjectRepositoryScreen } from "./AddProjectScreen";
import { defineNativePluginFeature } from "../../plugins/features";
export const AddProjectRepositoryRoute = defineNativePluginFeature(
  "native.features.projects.add-project-repository-route",
  BuiltinAddProjectRepositoryRoute,
);

type AddProjectRepositoryRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
};

function BuiltinAddProjectRepositoryRoute({
  route,
}: StaticScreenProps<AddProjectRepositoryRouteParams>) {
  return <AddProjectRepositoryScreen {...(route.params ?? {})} />;
}
