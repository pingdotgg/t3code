import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import {
  PrimaryEnvironmentHttpClient,
  primaryEnvironmentHttpClientLive,
} from "../environments/primary/httpClient";
import { primaryEnvironmentRequestInit } from "../environments/primary/requestInit";

import { browserCryptoLayer } from "../cloud/dpop";
import { webManagedRelayClientLayer } from "../cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

const webHttpClientLayer = remoteHttpClientLayer(globalThis.fetch);

export const remoteHttpRuntime = ManagedRuntime.make(webHttpClientLayer);

const primaryHttpRuntime = ManagedRuntime.make(
  primaryEnvironmentHttpClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer((input, init) => globalThis.fetch(input, init)),
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

export const webRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    webHttpClientLayer,
    browserCryptoLayer,
    webManagedRelayClientLayer(configuredRelayUrl()).pipe(
      Layer.provide(Layer.mergeAll(webHttpClientLayer, browserCryptoLayer)),
    ),
  ),
);
