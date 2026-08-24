import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:UpdateConnectivityInfo`.
 *
 * Replaces a core device's connectivity information — the endpoints and
 * ports client devices use to reach the core's local MQTT broker. Typically
 * driven by automation that knows the core's current IP (e.g. reacting to a
 * DHCP change). The caller supplies the core device's thing name and the new
 * endpoint list at runtime. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.UpdateConnectivityInfoHttp)`.
 * @binding
 * @section Managing Client Devices
 * @example Publish A Core's Broker Endpoint
 * ```typescript
 * // init — account-level binding, no resource argument
 * const updateConnectivityInfo = yield* AWS.GreengrassV2.UpdateConnectivityInfo();
 *
 * // runtime
 * yield* updateConnectivityInfo({
 *   thingName: "MyCore",
 *   connectivityInfo: [
 *     { id: "lan", hostAddress: "192.168.1.20", portNumber: 8883 },
 *   ],
 * });
 * ```
 */
export interface UpdateConnectivityInfo extends Binding.Service<
  UpdateConnectivityInfo,
  "AWS.GreengrassV2.UpdateConnectivityInfo",
  () => Effect.Effect<
    (
      request: greengrassv2.UpdateConnectivityInfoRequest,
    ) => Effect.Effect<
      greengrassv2.UpdateConnectivityInfoResponse,
      greengrassv2.UpdateConnectivityInfoError
    >
  >
> {}
export const UpdateConnectivityInfo = Binding.Service<UpdateConnectivityInfo>(
  "AWS.GreengrassV2.UpdateConnectivityInfo",
);
