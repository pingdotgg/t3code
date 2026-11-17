import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { AuthProvider } from "./AuthProvider.ts";

// Kept apart from `AuthProvider.ts` because `Stack.ts`, which every runtime
// imports, provides the registry: this module pulls in nothing but Effect.

/** Every registered {@link AuthProvider}, by provider name. */
export class AuthProviders extends Context.Service<
  AuthProviders,
  {
    [providerName: string]: AuthProvider;
  }
>()("AuthProviders") {}

/**
 * The registry a provider layer registers into: the ambient one when the
 * caller supplies it (to read the registrations back, as `alchemy profile`
 * does), otherwise a fresh one for this build. `Stack.build` provides it,
 * so callers never supply an empty registry.
 */
export const AuthProvidersLive = Layer.effect(
  AuthProviders,
  Effect.serviceOption(AuthProviders).pipe(Effect.map(Option.getOrElse(() => ({})))),
);
