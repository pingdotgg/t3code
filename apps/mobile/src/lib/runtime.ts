import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { fetch as expoFetch } from "expo/fetch";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";

import * as Dpop from "../features/cloud/dpop";
import * as ManagedRelayLayer from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";
import * as Tracing from "../features/observability/tracing";
import * as NativeWebSocket from "../native/nativeWebSocket";
import * as Persistence from "../persistence/layer";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";
import { whenProtectedDataAvailable } from "./protectedData";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relay.url ?? "http://relay.invalid";
}

const layerHttpClient = layerRemoteHttpClient(fetch);
// React Native's XMLHttpRequest fetch ignores `redirect`; Expo's native transport honors the exporter's "manual".
const layerTracingHttpClient = layerRemoteHttpClient(expoFetch);

type RuntimeLayerSource =
  | ReturnType<typeof ManagedRelayLayer.layer>
  | typeof NativeWebSocket.layer
  | typeof Dpop.layer
  | typeof layerHttpClient
  | typeof Persistence.layer
  | typeof Tracing.layer;

const layerRuntime = Layer.merge(
  ManagedRelayLayer.layer(configuredRelayUrl()),
  NativeWebSocket.layer,
).pipe(
  Layer.provideMerge(Dpop.layer),
  Layer.provideMerge(layerHttpClient),
  Layer.provideMerge(Tracing.layer.pipe(Layer.provide(layerTracingHttpClient))),
  Layer.provideMerge(Persistence.layer),
  // These layers read the keychain and the database while they build, and a
  // failed build is kept for the life of the process.
  Layer.provide(Layer.effectDiscard(Effect.promise(whenProtectedDataAvailable))),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
