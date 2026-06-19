import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";
import {
  PrimaryEnvironmentHttpClient,
  primaryEnvironmentHttpClientLive,
} from "../environments/primary/httpClient";
import {
  primaryEnvironmentRequestInit,
  withPrimaryHostAuthorization,
} from "../environments/primary/requestInit";

import { browserCryptoLayer } from "../cloud/dpop";
import { managedRelayClientLayer } from "../cloud/managedRelayLayer";
import { resolveCloudPublicConfig, resolveRelayTracingConfig } from "../cloud/publicConfig";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

const httpClientLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
const relayTracingLayer = makeRelayClientTracingLayer(resolveRelayTracingConfig(), {
  serviceName: "t3-web-relay-client",
  serviceVersion: import.meta.env.APP_VERSION,
  runtime: "browser",
  client: typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web",
}).pipe(Layer.provide(httpClientLayer));

export const remoteHttpRuntime = ManagedRuntime.make(httpClientLayer);

const primaryHttpRuntime = ManagedRuntime.make(
  primaryEnvironmentHttpClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer((input, init) =>
          globalThis.fetch(input, withPrimaryHostAuthorization(init, input)),
        ),
        Layer.succeed(FetchHttpClient.RequestInit, primaryEnvironmentRequestInit),
        httpHeaderRedactionLayer,
      ),
    ),
  ),
);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient>) =>
  primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

export const runtimeLayer = Layer.mergeAll(
  httpClientLayer,
  browserCryptoLayer,
  Socket.layerWebSocketConstructorGlobal,
  relayTracingLayer,
  managedRelayClientLayer(configuredRelayUrl()).pipe(
    Layer.provide(Layer.mergeAll(httpClientLayer, browserCryptoLayer)),
  ),
);

export const runtime = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer = Layer.effectContext(runtime.contextEffect);
