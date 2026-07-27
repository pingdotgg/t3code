import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DecoderManifest } from "./DecoderManifest.ts";

/**
 * `ListDecoderManifestNetworkInterfaces` request with `name` injected from
 * the bound decoder manifest.
 */
export interface ListDecoderManifestNetworkInterfacesRequest extends Omit<
  iotfleetwise.ListDecoderManifestNetworkInterfacesRequest,
  "name"
> {}

/**
 * Runtime binding for the `ListDecoderManifestNetworkInterfaces` operation
 * (IAM action `iotfleetwise:ListDecoderManifestNetworkInterfaces`), scoped
 * to one {@link DecoderManifest}.
 *
 * Lists the CAN/OBD/Ethernet network interfaces defined in the bound
 * decoder manifest. Provide the implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListDecoderManifestNetworkInterfacesHttp)`.
 *
 * @binding
 * @section Inspecting Signal Definitions
 * @example List a Decoder's Network Interfaces
 * ```typescript
 * const listNetworkInterfaces =
 *   yield* IoTFleetWise.ListDecoderManifestNetworkInterfaces(decoder);
 *
 * const { networkInterfaces } = yield* listNetworkInterfaces();
 * ```
 */
export interface ListDecoderManifestNetworkInterfaces extends Binding.Service<
  ListDecoderManifestNetworkInterfaces,
  "AWS.IoTFleetWise.ListDecoderManifestNetworkInterfaces",
  (
    decoder: DecoderManifest,
  ) => Effect.Effect<
    (
      request?: ListDecoderManifestNetworkInterfacesRequest,
    ) => Effect.Effect<
      iotfleetwise.ListDecoderManifestNetworkInterfacesResponse,
      iotfleetwise.ListDecoderManifestNetworkInterfacesError
    >
  >
> {}
export const ListDecoderManifestNetworkInterfaces =
  Binding.Service<ListDecoderManifestNetworkInterfaces>(
    "AWS.IoTFleetWise.ListDecoderManifestNetworkInterfaces",
  );
