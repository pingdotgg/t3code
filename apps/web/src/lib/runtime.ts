import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";
import {
  PrimaryEnvironmentHttpClient,
  primaryEnvironmentHttpClientLive,
} from "../environments/primary/httpClient";

export const remoteHttpRuntime = ManagedRuntime.make(remoteHttpClientLayer(globalThis.fetch));

const primaryHttpRuntime = ManagedRuntime.make(
  primaryEnvironmentHttpClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer((input, init) => globalThis.fetch(input, init)),
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
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
