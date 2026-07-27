import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicediscovery:GetOperation` — reads the status of
 * an asynchronous Cloud Map operation. `RegisterInstance` and
 * `DeregisterInstance` return an `OperationId`; poll it with this binding
 * to await completion (`SUCCESS` / `FAIL`) before relying on the
 * registration. Provide the implementation with
 * `Effect.provide(AWS.CloudMap.GetOperationHttp)`.
 * @binding
 * @section Registering Instances
 * @example Await a Registration Operation
 * ```typescript
 * const registerInstance = yield* AWS.CloudMap.RegisterInstance(service);
 * const getOperation = yield* AWS.CloudMap.GetOperation();
 *
 * const { OperationId } = yield* registerInstance({
 *   InstanceId: "worker-1",
 *   Attributes: { AWS_INSTANCE_IPV4: "10.0.1.10" },
 * });
 * const { Operation } = yield* getOperation({ OperationId: OperationId! });
 * console.log(Operation?.Status); // "SUBMITTED" | "PENDING" | "SUCCESS" | "FAIL"
 * ```
 */
export interface GetOperation extends Binding.Service<
  GetOperation,
  "AWS.CloudMap.GetOperation",
  () => Effect.Effect<
    (
      request: SD.GetOperationRequest,
    ) => Effect.Effect<SD.GetOperationResponse, SD.GetOperationError>
  >
> {}
export const GetOperation = Binding.Service<GetOperation>(
  "AWS.CloudMap.GetOperation",
);
