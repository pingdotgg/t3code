import type { StaticScreenProps } from "@react-navigation/native";
import { useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";

import { NewTaskDraftScreen } from "./NewTaskDraftScreen";

type NewTaskDraftRouteParams = {
  readonly environmentId?: string | string[];
  readonly projectId?: string | string[];
  readonly title?: string | string[];
  readonly pendingTaskId?: string | string[];
  readonly incomingShareId?: string | string[];
  readonly createInChatScratch?: string | string[];
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function NewTaskDraftRouteScreen({ route }: StaticScreenProps<NewTaskDraftRouteParams>) {
  const params = route.params ?? {};

  // Keyed on the params object so a fresh navigation to this (already
  // mounted) screen produces a new reference, letting the draft screen
  // re-apply the requested project.
  const initialProjectRef = useMemo(
    () => ({
      environmentId: firstParam(params.environmentId),
      projectId: firstParam(params.projectId),
    }),
    [route.params],
  );

  return (
    <>
      <NativeStackScreenOptions
        options={{
          title: firstParam(params.title) ?? "New task",
        }}
      />
      <NewTaskDraftScreen
        createInChatScratch={firstParam(params.createInChatScratch) === "true"}
        initialProjectRef={initialProjectRef}
        incomingShareId={firstParam(params.incomingShareId)}
        pendingTaskId={firstParam(params.pendingTaskId)}
      />
    </>
  );
}
