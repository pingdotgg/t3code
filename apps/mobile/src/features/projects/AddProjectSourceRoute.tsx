import { AddProjectSourceScreen } from "./AddProjectScreen";
import type { StaticScreenProps } from "@react-navigation/native";

type AddProjectSourceRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectSourceRoute({
  route,
}: StaticScreenProps<AddProjectSourceRouteParams | undefined>) {
  return <AddProjectSourceScreen environmentId={route.params?.environmentId} />;
}
