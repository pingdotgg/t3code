import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectNewScreen } from "./AddProjectScreen";

type AddProjectNewRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectNewRoute({
  route,
}: StaticScreenProps<AddProjectNewRouteParams | undefined>) {
  return <AddProjectNewScreen {...(route.params ?? {})} />;
}
