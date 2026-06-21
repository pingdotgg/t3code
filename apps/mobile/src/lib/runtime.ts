import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

import { cryptoLayer } from "../features/cloud/dpop";
import { managedRelayClientLayer } from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";
import { tracingLayer } from "../features/observability/tracing";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relay.url ?? "http://relay.invalid";
}

const httpClientLayer = remoteHttpClientLayer(fetch);

export const runtimeLayer = Layer.merge(
  managedRelayClientLayer(configuredRelayUrl()),
  Socket.layerWebSocketConstructorGlobal,
).pipe(
  Layer.provideMerge(cryptoLayer),
  Layer.provideMerge(httpClientLayer),
  Layer.provideMerge(tracingLayer.pipe(Layer.provide(httpClientLayer))),
);

export const runtime = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer = Layer.effectContext(runtime.contextEffect);
