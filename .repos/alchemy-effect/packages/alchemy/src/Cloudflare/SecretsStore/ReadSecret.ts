import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Secret } from "./Secret.ts";

/**
 * Bind a {@link Secret} to a Worker and obtain the Effect-native secret
 * client. The client is itself an `Effect` that resolves to the secret's
 * current value.
 *
 * `ReadSecret` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.SecretsStore.ReadSecret(ApiKey)`.
 *
 * @example Reading a secret at runtime
 * ```typescript
 * const apiKey = yield* Cloudflare.SecretsStore.ReadSecret(ApiKey);
 * const value = yield* apiKey;
 * ```
 *
 * @binding
 * @product Secrets Store
 * @category Storage & Databases
 */
export interface ReadSecret extends Binding.Service<
  ReadSecret,
  "Cloudflare.SecretsStore.ReadSecret",
  (secret: Secret) => Effect.Effect<ReadSecretClient>
> {}

export const ReadSecret = Binding.Service<ReadSecret>(
  "Cloudflare.SecretsStore.ReadSecret",
);

export class SecretError extends Data.TaggedError("SecretError")<{
  message: string;
  cause: Error;
}> {}

/**
 * A bound secret. The client itself is an `Effect` that resolves to the
 * secret's current value, so you can `yield* apiKey` directly. Use `.get()`
 * for the same thing as a callable, or `.raw` for the underlying
 * `SecretsStoreSecret` binding.
 */
export interface ReadSecretClient extends Effect.Effect<
  Redacted.Redacted<string>,
  SecretError,
  RuntimeContext
> {
  /**
   * Effect that resolves to the raw Cloudflare `SecretsStoreSecret` binding.
   */
  raw: Effect.Effect<runtime.SecretsStoreSecret, never, RuntimeContext>;
  /**
   * Read the current value of the secret.
   */
  get(): Effect.Effect<Redacted.Redacted<string>, SecretError, RuntimeContext>;
}
