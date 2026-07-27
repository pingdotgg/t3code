import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iotwireless:GetServiceEndpoint` — read the
 * account's CUPS or LNS endpoint (and its server trust certificate) from a
 * deployed Lambda or Task. Useful for gateway provisioning flows.
 *
 * @binding
 * @section Reading the Service Endpoint
 * Provide the `GetServiceEndpointHttp` implementation layer on the Function
 * effect, bind the capability in the init phase, then call the returned
 * client at runtime.
 *
 * @example Read the LNS Endpoint
 * ```typescript
 * // init
 * const getEndpoint = yield* AWS.IoTWireless.GetServiceEndpoint();
 *
 * // runtime
 * const { ServiceEndpoint } = yield* getEndpoint({ ServiceType: "LNS" });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.GetServiceEndpointHttp))
 * ```
 */
export interface GetServiceEndpoint extends Binding.Service<
  GetServiceEndpoint,
  "AWS.IoTWireless.GetServiceEndpoint",
  () => Effect.Effect<
    (
      request?: iotw.GetServiceEndpointRequest,
    ) => Effect.Effect<
      iotw.GetServiceEndpointResponse,
      iotw.GetServiceEndpointError
    >
  >
> {}
export const GetServiceEndpoint = Binding.Service<GetServiceEndpoint>(
  "AWS.IoTWireless.GetServiceEndpoint",
);
