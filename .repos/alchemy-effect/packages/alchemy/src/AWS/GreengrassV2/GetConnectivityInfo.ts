import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:GetConnectivityInfo`.
 *
 * Reads a core device's connectivity information — the endpoints and ports
 * where client devices can reach the core's local MQTT broker (the same data
 * the IoT Greengrass discovery API serves). The caller supplies the core
 * device's thing name at runtime. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.GetConnectivityInfoHttp)`.
 * @binding
 * @section Managing Client Devices
 * @example Read A Core's Broker Endpoints
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getConnectivityInfo = yield* AWS.GreengrassV2.GetConnectivityInfo();
 *
 * // runtime
 * const { connectivityInfo } = yield* getConnectivityInfo({
 *   thingName: "MyCore",
 * });
 * ```
 */
export interface GetConnectivityInfo extends Binding.Service<
  GetConnectivityInfo,
  "AWS.GreengrassV2.GetConnectivityInfo",
  () => Effect.Effect<
    (
      request: greengrassv2.GetConnectivityInfoRequest,
    ) => Effect.Effect<
      greengrassv2.GetConnectivityInfoResponse,
      greengrassv2.GetConnectivityInfoError
    >
  >
> {}
export const GetConnectivityInfo = Binding.Service<GetConnectivityInfo>(
  "AWS.GreengrassV2.GetConnectivityInfo",
);
