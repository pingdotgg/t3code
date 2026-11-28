import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { type EnvironmentId, FilesystemBrowseError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { newTaskFlowKey } from "../threads/new-task-flow-state";
import { isDraftThreadRoute, type NewTaskDraftRouteParams } from "../threads/thread-route-state";

const isFilesystemBrowseError = Schema.is(FilesystemBrowseError);

/** Clone destinations may name folders that do not exist yet; cloning creates them. */
export function isMissingCloneParentBrowseFailure(input: {
  readonly cloning: boolean;
  readonly failure: unknown;
}): boolean {
  return (
    input.cloning &&
    isFilesystemBrowseError(input.failure) &&
    input.failure.failure === "read_directory_failed" &&
    input.failure.pathMissing === true
  );
}

export function resolveAddProjectEnvironment<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  },
>(environmentOptions: ReadonlyArray<T>, requestedEnvironmentId: EnvironmentId | null): T | null {
  if (requestedEnvironmentId !== null) {
    return (
      environmentOptions.find(
        (environment) =>
          environment.environmentId === requestedEnvironmentId &&
          canCreateProjectInEnvironment(environment.connectionState),
      ) ?? null
    );
  }

  return (
    environmentOptions.find((environment) =>
      canCreateProjectInEnvironment(environment.connectionState),
    ) ?? null
  );
}

interface StackRoute {
  readonly key: string;
  readonly name: string;
  readonly params?: object;
}

const firstParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * The draft whose project chooser opened Add project, so the added project is picked for it as
 * choosing one in the chooser is. Null when Add project opened from anywhere else.
 */
export function chooserDraftKey(
  routes: ReadonlyArray<StackRoute>,
  readFlowDraftKey: (flowKey: string) => string | null,
): string | null {
  const chooserIndex = routes.findLastIndex((route) => !route.name.startsWith("AddProject"));
  const chooser = routes[chooserIndex];
  if (chooser?.name !== "NewTaskProject") return null;
  const savedDraftId = firstParam((chooser.params as { draftId?: string | string[] })?.draftId);
  if (savedDraftId !== undefined) return savedDraftId;
  const draftRoute = routes[chooserIndex - 1];
  if (draftRoute === undefined || !isDraftThreadRoute(draftRoute)) return null;
  const flowKey = newTaskFlowKey(draftRoute);
  const draft = (draftRoute.params as { draft: NewTaskDraftRouteParams }).draft;
  return (flowKey && readFlowDraftKey(flowKey)) ?? firstParam(draft.draftId) ?? null;
}
