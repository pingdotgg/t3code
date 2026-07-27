import type * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DecoderManifest } from "./DecoderManifest.ts";

/**
 * `ListDecoderManifestSignals` request with `name` injected from the bound
 * decoder manifest.
 */
export interface ListDecoderManifestSignalsRequest extends Omit<
  iotfleetwise.ListDecoderManifestSignalsRequest,
  "name"
> {}

/**
 * Runtime binding for the `ListDecoderManifestSignals` operation (IAM
 * action `iotfleetwise:ListDecoderManifestSignals`), scoped to one
 * {@link DecoderManifest}.
 *
 * Lists the signal decoders (CAN/OBD/message decoding rules) defined in
 * the bound decoder manifest. Provide the implementation with
 * `Effect.provide(AWS.IoTFleetWise.ListDecoderManifestSignalsHttp)`.
 *
 * @binding
 * @section Inspecting Signal Definitions
 * @example List a Decoder's Signal Decoders
 * ```typescript
 * const listDecoderSignals =
 *   yield* IoTFleetWise.ListDecoderManifestSignals(decoder);
 *
 * const { signalDecoders } = yield* listDecoderSignals();
 * ```
 */
export interface ListDecoderManifestSignals extends Binding.Service<
  ListDecoderManifestSignals,
  "AWS.IoTFleetWise.ListDecoderManifestSignals",
  (
    decoder: DecoderManifest,
  ) => Effect.Effect<
    (
      request?: ListDecoderManifestSignalsRequest,
    ) => Effect.Effect<
      iotfleetwise.ListDecoderManifestSignalsResponse,
      iotfleetwise.ListDecoderManifestSignalsError
    >
  >
> {}
export const ListDecoderManifestSignals =
  Binding.Service<ListDecoderManifestSignals>(
    "AWS.IoTFleetWise.ListDecoderManifestSignals",
  );
