import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface RegisterInstanceRequest extends Omit<
  SD.RegisterInstanceRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:RegisterInstance` — lets a
 * self-registering workload create or update its own Cloud Map instance
 * (an upsert on the instance ID).
 *
 * The response carries an `OperationId`; registration completes
 * asynchronously on the Cloud Map side.
 * @binding
 * @section Registering Instances
 * @example Self-register on Startup
 * ```typescript
 * const registerInstance = yield* AWS.CloudMap.RegisterInstance(service);
 *
 * yield* registerInstance({
 *   InstanceId: "worker-1",
 *   Attributes: { AWS_INSTANCE_IPV4: "10.0.1.10" },
 * });
 * ```
 */
export interface RegisterInstance extends Binding.Service<
  RegisterInstance,
  "AWS.CloudMap.RegisterInstance",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request: RegisterInstanceRequest,
    ) => Effect.Effect<SD.RegisterInstanceResponse, SD.RegisterInstanceError>
  >
> {}
export const RegisterInstance = Binding.Service<RegisterInstance>(
  "AWS.CloudMap.RegisterInstance",
);
