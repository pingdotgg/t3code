import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Auth } from "./Auth.ts";
import {
  backendEnvKey,
  backendString,
  bindBackendEnvironment,
} from "./BackendConnection.ts";

export interface ConnectAuthClient {
  /** Public managed Better Auth URL for the standard Neon auth client. */
  baseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Public JWKS endpoint. Verify signature, issuer, audience and expiry with an established JWT library. */
  jwksUrl: Effect.Effect<string, never, RuntimeContext>;
}

/**
 * Bind managed Auth's public connection configuration. This does not create an
 * admin credential, verify a JWT, or replace the standard Neon Auth SDK.
 *
 * ### Connect managed authentication
 * **Example:** Obtain configuration inside a Function
 * ```typescript
 * const authClient = yield* Neon.ConnectAuth(auth);
 * // In the request handler:
 * const baseUrl = yield* authClient.baseUrl;
 * ```
 *
 * @binding
 * @product Auth
 */
export interface ConnectAuth extends Binding.Service<
  ConnectAuth,
  "Neon.ConnectAuth",
  (auth: Auth) => Effect.Effect<ConnectAuthClient>
> {}
export const ConnectAuth = Binding.Service<ConnectAuth>("Neon.ConnectAuth");

/** Bind public Auth URLs on Neon Functions, Workers, Lambda and other env hosts. */
export const ConnectAuthHttp = Layer.succeed(
  ConnectAuth,
  Effect.fn(function* (auth: Auth) {
    const baseUrl = backendEnvKey(auth.FQN, "AUTH_URL");
    const jwksUrl = backendEnvKey(auth.FQN, "AUTH_JWKS_URL");
    yield* bindBackendEnvironment(`Neon.ConnectAuth:${auth.FQN}`, {
      [baseUrl]: auth.baseUrl,
      [jwksUrl]: auth.jwksUrl,
    });
    return {
      baseUrl: backendString(baseUrl),
      jwksUrl: backendString(jwksUrl),
    } satisfies ConnectAuthClient;
  }),
);
