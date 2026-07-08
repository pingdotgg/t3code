import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectLocalFolderScreen } from "./AddProjectScreen";

type AddProjectLocalRouteParams = {
  readonly environmentId?: string | string[];
};

export function AddProjectLocalRoute({
  route,
}: StaticScreenProps<AddProjectLocalRouteParams | undefined>) {
  return <AddProjectLocalFolderScreen {...(route.params ?? {})} />;
}
