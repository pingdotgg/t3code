import { fetch as expoFetch } from "expo/fetch";
import Constants from "expo-constants";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

import { mobileCryptoLayer } from "../features/cloud/dpop";
import { mobileManagedRelayClientLayer } from "../features/cloud/managedRelayLayer";

function configuredRelayUrl(): string {
  const relay = Constants.expoConfig?.extra?.relay as { readonly url?: string | null } | undefined;
  const value = relay?.url?.trim();
  return value ? value.replace(/\/+$/g, "") : "http://relay.invalid";
}

const mobileHttpClientLayer = remoteHttpClientLayer(expoFetch);

export const mobileRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    mobileHttpClientLayer,
    mobileCryptoLayer,
    mobileManagedRelayClientLayer(configuredRelayUrl()).pipe(
      Layer.provide(Layer.mergeAll(mobileHttpClientLayer, mobileCryptoLayer)),
    ),
  ),
);
