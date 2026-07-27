import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface DeregisterInstanceRequest extends Omit<
  SD.DeregisterInstanceRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:DeregisterInstance` — lets a
 * self-registering workload remove its own Cloud Map instance (and the
 * Route 53 records/health check Cloud Map created for it).
 *
 * The response carries an `OperationId`; deregistration completes
 * asynchronously on the Cloud Map side.
 * @binding
 * @section Deregistering Instances
 * @example Deregister on Shutdown
 * ```typescript
 * const deregisterInstance = yield* AWS.CloudMap.DeregisterInstance(service);
 *
 * yield* deregisterInstance({ InstanceId: "worker-1" });
 * ```
 */
export interface DeregisterInstance extends Binding.Service<
  DeregisterInstance,
  "AWS.CloudMap.DeregisterInstance",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request: DeregisterInstanceRequest,
    ) => Effect.Effect<
      SD.DeregisterInstanceResponse,
      SD.DeregisterInstanceError
    >
  >
> {}
export const DeregisterInstance = Binding.Service<DeregisterInstance>(
  "AWS.CloudMap.DeregisterInstance",
);
