import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

export interface EnvironmentSectionsInput {
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly cloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord> | null;
}

export interface EnvironmentSections {
  readonly localEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly availableCloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord>;
}

export function savedRelayEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly hasRelayRoute: boolean;
  }>,
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments
      .filter((environment) => environment.hasRelayRoute)
      .map((environment) => environment.environmentId),
  );
}

export function splitEnvironmentSections(input: EnvironmentSectionsInput): EnvironmentSections {
  const savedEnvironmentIds = savedRelayEnvironmentIds(input.connectedEnvironments);

  return {
    localEnvironments: input.connectedEnvironments.filter(
      (environment) => !environment.isRelayManaged,
    ),
    connectedCloudEnvironments: input.connectedEnvironments.filter(
      (environment) => environment.isRelayManaged,
    ),
    availableCloudEnvironments: (input.cloudEnvironments ?? []).filter(
      (environment) => !savedEnvironmentIds.has(environment.environmentId),
    ),
  };
}
