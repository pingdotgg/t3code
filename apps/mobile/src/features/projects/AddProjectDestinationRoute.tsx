import type { StaticScreenProps } from "@react-navigation/native";
import { AddProjectDestinationScreen } from "./AddProjectScreen";

type AddProjectDestinationRouteParams = {
  readonly environmentId?: string | string[];
  readonly source?: string | string[];
  readonly remoteUrl?: string | string[];
  readonly repositoryTitle?: string | string[];
  readonly repositoryName?: string | string[];
  /** A prompt link's prompt, for the draft the clone opens. */
  readonly prompt?: string | string[];
};

export function AddProjectDestinationRoute({
  route,
}: StaticScreenProps<AddProjectDestinationRouteParams | undefined>) {
  return <AddProjectDestinationScreen {...(route.params ?? {})} />;
}
