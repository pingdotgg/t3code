/**
 * Shared scaffolding for Fly SecretKey HTTP bindings.
 *
 * NOT exported from `index.ts`.
 */
import type * as Effect from "effect/Effect";
import type { SecretAuth } from "./SecretHttp.ts";
import { makeHttpSecretBinding } from "./SecretHttp.ts";
import type { SecretKey } from "./SecretKey.ts";

export const bytesToBase64 = (bytes: Uint8Array | ArrayLike<number>): string =>
  Buffer.from(
    bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes),
  ).toString("base64");

export const base64ToBytes = (value: string | undefined): Uint8Array =>
  Uint8Array.from(Buffer.from(value ?? "", "base64"));

export const makeHttpSecretKeyBinding = <Client>(options: {
  makeClient: (
    auth: SecretAuth,
    appName: Effect.Effect<string>,
    secretName: Effect.Effect<string>,
  ) => Client;
}) => makeHttpSecretBinding<SecretKey, Client>({ ...options, kms: true });
