import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { isMissingBrowsePathFailure } from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId } from "@t3tools/contracts";

/** Clone destinations may name folders that do not exist yet; cloning creates them. */
export function isMissingCloneParentBrowseFailure(input: {
  readonly cloning: boolean;
  readonly failure: unknown;
}): boolean {
  return input.cloning && isMissingBrowsePathFailure(input.failure);
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
