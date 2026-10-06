import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** A provider binding stores opaque bytes; only its adapter decodes or refreshes them. */
export const make = Effect.fn("ProviderCredentialStore.make")(function* (
  driver: string,
  bindingId: string,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  // Hash the tuple so arbitrary bindings cannot escape or exceed a filename.
  const bindingHash = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${driver.length}:${driver}${bindingId}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  const key = `provider-auth-${bindingHash}`;
  return {
    binding: { owner: "t3" as const, key },
    get: secrets.get(key),
    set: (credentials: Uint8Array) => secrets.set(key, credentials),
    remove: secrets.remove(key),
  };
});
