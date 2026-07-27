import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

export interface GetManagedEndpointSessionCredentialsRequest extends Omit<
  emrc.GetManagedEndpointSessionCredentialsRequest,
  "virtualClusterIdentifier" | "durationInSeconds"
> {
  /**
   * How long the session token stays valid (wire unit: seconds).
   * @default the endpoint type's default session duration
   */
  duration?: Duration.Input;
}

/**
 * Runtime binding for `emr-containers:GetManagedEndpointSessionCredentials`.
 *
 * Mints a session token for connecting to a managed endpoint (EMR Studio
 * gateway) on the bound {@link VirtualCluster}. The virtual cluster
 * identifier is injected from the binding; pass the `endpointIdentifier`,
 * the `executionRoleArn` to run as, and the `credentialType`
 * (`TOKEN`). The returned `credentials.token` is a
 * `Redacted` value — call `Redacted.value(...)` at the point of use.
 * Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.GetManagedEndpointSessionCredentialsHttp)`.
 * @binding
 * @section Managed Endpoints
 * @example Mint A Session Token
 * ```typescript
 * // init
 * const getSessionCredentials =
 *   yield* AWS.EMRContainers.GetManagedEndpointSessionCredentials(virtualCluster);
 *
 * // runtime
 * const { credentials } = yield* getSessionCredentials({
 *   endpointIdentifier: endpointId,
 *   executionRoleArn: jobRoleArn,
 *   credentialType: "TOKEN",
 *   duration: "15 minutes",
 * });
 * const token = Redacted.value(credentials!.token);
 * ```
 */
export interface GetManagedEndpointSessionCredentials extends Binding.Service<
  GetManagedEndpointSessionCredentials,
  "AWS.EMRContainers.GetManagedEndpointSessionCredentials",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request: GetManagedEndpointSessionCredentialsRequest,
    ) => Effect.Effect<
      emrc.GetManagedEndpointSessionCredentialsResponse,
      emrc.GetManagedEndpointSessionCredentialsError
    >
  >
> {}
export const GetManagedEndpointSessionCredentials =
  Binding.Service<GetManagedEndpointSessionCredentials>(
    "AWS.EMRContainers.GetManagedEndpointSessionCredentials",
  );
