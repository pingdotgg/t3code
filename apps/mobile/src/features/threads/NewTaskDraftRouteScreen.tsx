import type { StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

type NewTaskDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly title?: string | string[];
};

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const params = route.params ?? {};

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: Array.isArray(params.title) ? params.title[0] : (params.title ?? "New task"),
        }}
      />
      <NewTaskDraftScreen
        initialProjectRef={{
          environmentId: Array.isArray(params.environmentId)
            ? params.environmentId[0]
            : params.environmentId,
          projectId: Array.isArray(params.projectId) ? params.projectId[0] : params.projectId,
        }}
      />
    </>
  );
}
