import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * `GetInstancesHealthStatus` request with `ServiceId` injected from the
 * bound {@link Service}.
 */
export interface GetInstancesHealthStatusRequest extends Omit<
  SD.GetInstancesHealthStatusRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:GetInstancesHealthStatus` — reads
 * the current health status (`HEALTHY`, `UNHEALTHY`, or `UNKNOWN`) of the
 * bound {@link Service}'s instances. There is a brief delay between
 * registering an instance and its health status becoming available.
 * Provide the implementation with
 * `Effect.provide(AWS.CloudMap.GetInstancesHealthStatusHttp)`.
 * @binding
 * @section Instance Health
 * @example Read Health of All Instances
 * ```typescript
 * const getInstancesHealthStatus =
 *   yield* AWS.CloudMap.GetInstancesHealthStatus(service);
 *
 * const { Status } = yield* getInstancesHealthStatus();
 * console.log(Status?.["worker-1"]); // "HEALTHY" | "UNHEALTHY" | "UNKNOWN"
 * ```
 *
 * @example Read Health of Specific Instances
 * ```typescript
 * const { Status } = yield* getInstancesHealthStatus({
 *   Instances: ["worker-1", "worker-2"],
 * });
 * ```
 */
export interface GetInstancesHealthStatus extends Binding.Service<
  GetInstancesHealthStatus,
  "AWS.CloudMap.GetInstancesHealthStatus",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request?: GetInstancesHealthStatusRequest,
    ) => Effect.Effect<
      SD.GetInstancesHealthStatusResponse,
      SD.GetInstancesHealthStatusError
    >
  >
> {}
export const GetInstancesHealthStatus =
  Binding.Service<GetInstancesHealthStatus>(
    "AWS.CloudMap.GetInstancesHealthStatus",
  );
