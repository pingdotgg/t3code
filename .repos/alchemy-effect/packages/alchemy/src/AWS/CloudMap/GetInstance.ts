import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * `GetInstance` request with `ServiceId` injected from the bound
 * {@link Service}.
 */
export interface GetInstanceRequest extends Omit<
  SD.GetInstanceRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:GetInstance` — reads a single
 * registered instance of the bound {@link Service} by its instance ID,
 * returning its full attribute map. Provide the implementation with
 * `Effect.provide(AWS.CloudMap.GetInstanceHttp)`.
 * @binding
 * @section Reading Instances
 * @example Read an Instance's Attributes
 * ```typescript
 * const getInstance = yield* AWS.CloudMap.GetInstance(service);
 *
 * const { Instance } = yield* getInstance({ InstanceId: "worker-1" });
 * console.log(Instance?.Attributes?.AWS_INSTANCE_IPV4);
 * ```
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "AWS.CloudMap.GetInstance",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request: GetInstanceRequest,
    ) => Effect.Effect<SD.GetInstanceResponse, SD.GetInstanceError>
  >
> {}
export const GetInstance = Binding.Service<GetInstance>(
  "AWS.CloudMap.GetInstance",
);
