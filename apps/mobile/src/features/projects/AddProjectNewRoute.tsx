import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectNewScreen } from "./AddProjectScreen";
import { defineNativePluginFeature } from "../../plugins/features";
export const AddProjectNewRoute = defineNativePluginFeature(
  "native.features.projects.add-project-new-route",
  BuiltinAddProjectNewRoute,
);

type AddProjectNewRouteParams = {
  readonly environmentId?: string | string[];
};

function BuiltinAddProjectNewRoute({
  route,
}: StaticScreenProps<AddProjectNewRouteParams | undefined>) {
  return <AddProjectNewScreen {...(route.params ?? {})} />;
}
