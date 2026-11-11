import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import type { DecoderManifest } from "./DecoderManifest.ts";
import { ListDecoderManifestNetworkInterfaces } from "./ListDecoderManifestNetworkInterfaces.ts";

export const ListDecoderManifestNetworkInterfacesHttp = Layer.effect(
  ListDecoderManifestNetworkInterfaces,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.ListDecoderManifestNetworkInterfaces",
    operation: iotfleetwise.listDecoderManifestNetworkInterfaces,
    actions: ["iotfleetwise:ListDecoderManifestNetworkInterfaces"],
    requestKey: "name",
    identifier: (decoder: DecoderManifest) => decoder.decoderManifestName,
    resources: (decoder: DecoderManifest) => [decoder.decoderManifestArn],
  }),
);
