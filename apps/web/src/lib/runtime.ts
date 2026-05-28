import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

import { browserCryptoLayer } from "../cloud/dpop";
import { webManagedRelayClientLayer } from "../cloud/managedRelayLayer";

function configuredRelayUrl(): string {
  const value = (import.meta.env.VITE_T3_RELAY_URL as string | undefined)?.trim();
  return value ? value.replace(/\/+$/g, "") : "http://relay.invalid";
}

const webHttpClientLayer = remoteHttpClientLayer(globalThis.fetch);

export const webRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    webHttpClientLayer,
    browserCryptoLayer,
    webManagedRelayClientLayer(configuredRelayUrl()).pipe(
      Layer.provide(Layer.mergeAll(webHttpClientLayer, browserCryptoLayer)),
    ),
  ),
);
