import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

export const primaryEnvironmentRequestInit = { credentials: "include" } as const;

export const withPrimaryEnvironmentRequestInit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, primaryEnvironmentRequestInit));
