import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectSourceScreen } from "./AddProjectScreen";
import { defineNativePluginFeature } from "../../plugins/features";
export const AddProjectSourceRoute = defineNativePluginFeature(
  "native.features.projects.add-project-source-route",
  BuiltinAddProjectSourceRoute,
);

type AddProjectSourceRouteParams = {
  readonly environmentId?: string | string[];
};

function BuiltinAddProjectSourceRoute({
  route,
}: StaticScreenProps<AddProjectSourceRouteParams | undefined>) {
  return <AddProjectSourceScreen {...(route.params ?? {})} />;
}
