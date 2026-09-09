import type * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";
import {
  SecretKey,
  type SecretKeyAccessor,
  type SecretKeyPayload,
} from "./SecretKey.ts";

/** The binding value produced by calling {@link SecretKey} (declared on `env` or `yield*`-ed). */
export type SecretKeyBinding = Binding.Binding<
  SecretKey["key"],
  SecretKeyAccessor,
  SecretKey
> &
  Readonly<SecretKeyPayload>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers Secret Key binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.SecretKeyBinding)`)
 * so that yielding a {@link SecretKey} binding attaches the native
 * `secret_key` binding to the surrounding Worker at deploy time and, at
 * runtime, resolves to a deferred {@link SecretKeyAccessor} (yield it to
 * obtain the native `CryptoKey`).
 */
export const SecretKeyBinding = makeBindingLayer<
  SecretKey,
  // The ambient global type, matching SecretKeyAccessor and InferEnv's
  // SecretKeyBinding mapping.
  CryptoKey,
  SecretKeyAccessor
>(SecretKey, (raw) => raw);
