import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectLocalFolderScreen } from "./AddProjectScreen";
import { defineNativePluginFeature } from "../../plugins/features";
export const AddProjectLocalRoute = defineNativePluginFeature(
  "native.features.projects.add-project-local-route",
  BuiltinAddProjectLocalRoute,
);

type AddProjectLocalRouteParams = {
  readonly environmentId?: string | string[];
};

function BuiltinAddProjectLocalRoute({
  route,
}: StaticScreenProps<AddProjectLocalRouteParams | undefined>) {
  return <AddProjectLocalFolderScreen {...(route.params ?? {})} />;
}
