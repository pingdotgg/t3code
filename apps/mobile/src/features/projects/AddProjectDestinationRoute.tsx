import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectDestinationScreen } from "./AddProjectScreen";
import { defineNativePluginFeature } from "../../plugins/features";
export const AddProjectDestinationRoute = defineNativePluginFeature(
  "native.features.projects.add-project-destination-route",
  BuiltinAddProjectDestinationRoute,
);

type AddProjectDestinationRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repositoryTitle?: string | string[];
  readonly repositoryName?: string | string[];
  readonly prompt?: string | string[];
};

function BuiltinAddProjectDestinationRoute({
  route,
}: StaticScreenProps<AddProjectDestinationRouteParams | undefined>) {
  return <AddProjectDestinationScreen {...(route.params ?? {})} />;
}
