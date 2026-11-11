import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import type { DecoderManifest } from "./DecoderManifest.ts";
import { ListDecoderManifestSignals } from "./ListDecoderManifestSignals.ts";

export const ListDecoderManifestSignalsHttp = Layer.effect(
  ListDecoderManifestSignals,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.ListDecoderManifestSignals",
    operation: iotfleetwise.listDecoderManifestSignals,
    actions: ["iotfleetwise:ListDecoderManifestSignals"],
    requestKey: "name",
    identifier: (decoder: DecoderManifest) => decoder.decoderManifestName,
    resources: (decoder: DecoderManifest) => [decoder.decoderManifestArn],
  }),
);
