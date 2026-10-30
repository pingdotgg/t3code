import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectSourceScreen } from "./AddProjectScreen";

type AddProjectSourceRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectSourceRoute({
  route,
}: StaticScreenProps<AddProjectSourceRouteParams | undefined>) {
  return <AddProjectSourceScreen {...(route.params ?? {})} />;
}
