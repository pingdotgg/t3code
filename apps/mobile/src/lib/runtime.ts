import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

import { mobileCryptoLayer } from "../features/cloud/dpop";
import { mobileManagedRelayClientLayer } from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

const mobileHttpClientLayer = remoteHttpClientLayer(fetch);

export const mobileRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    mobileHttpClientLayer,
    mobileCryptoLayer,
    mobileManagedRelayClientLayer(configuredRelayUrl()).pipe(
      Layer.provide(Layer.mergeAll(mobileHttpClientLayer, mobileCryptoLayer)),
    ),
  ),
);
