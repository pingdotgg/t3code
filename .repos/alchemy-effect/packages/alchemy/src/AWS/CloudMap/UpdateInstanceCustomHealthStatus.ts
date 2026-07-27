import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * `UpdateInstanceCustomHealthStatus` request with `ServiceId` injected from
 * the bound {@link Service}.
 */
export interface UpdateInstanceCustomHealthStatusRequest extends Omit<
  SD.UpdateInstanceCustomHealthStatusRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:UpdateInstanceCustomHealthStatus` —
 * pushes an instance's health status (`HEALTHY` / `UNHEALTHY`) for a
 * service configured with `healthCheckCustomConfig`. This is the push-based
 * health mechanism: the workload reports its own health instead of being
 * probed by Route 53. Provide the implementation with
 * `Effect.provide(AWS.CloudMap.UpdateInstanceCustomHealthStatusHttp)`.
 * @binding
 * @section Instance Health
 * @example Report the Instance Healthy
 * ```typescript
 * const updateInstanceCustomHealthStatus =
 *   yield* AWS.CloudMap.UpdateInstanceCustomHealthStatus(service);
 *
 * yield* updateInstanceCustomHealthStatus({
 *   InstanceId: "worker-1",
 *   Status: "HEALTHY",
 * });
 * ```
 */
export interface UpdateInstanceCustomHealthStatus extends Binding.Service<
  UpdateInstanceCustomHealthStatus,
  "AWS.CloudMap.UpdateInstanceCustomHealthStatus",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request: UpdateInstanceCustomHealthStatusRequest,
    ) => Effect.Effect<
      SD.UpdateInstanceCustomHealthStatusResponse,
      SD.UpdateInstanceCustomHealthStatusError
    >
  >
> {}
export const UpdateInstanceCustomHealthStatus =
  Binding.Service<UpdateInstanceCustomHealthStatus>(
    "AWS.CloudMap.UpdateInstanceCustomHealthStatus",
  );
