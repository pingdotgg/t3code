import * as Effect from "effect/Effect";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

/** A provider binding stores opaque bytes; only its adapter decodes or refreshes them. */
export const makeProviderCredentialStore = Effect.fn("makeProviderCredentialStore")(function* (
  driver: string,
  bindingId: string,
) {
  const secrets = yield* ServerSecretStore;
  // Hex keeps arbitrary instance IDs out of paths and avoids delimiter collisions.
  const key = `provider-auth-${Buffer.from(`${driver.length}:${driver}${bindingId}`).toString("hex")}`;
  return {
    binding: { owner: "t3" as const, key },
    get: secrets.get(key),
    set: (credentials: Uint8Array) => secrets.set(key, credentials),
    remove: secrets.remove(key),
  };
});
