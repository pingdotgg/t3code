import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

// Hash the tuple so arbitrary bindings cannot escape or exceed a filename.
export const secretName = (driver: string, bindingId: string) =>
  `provider-auth-${NodeCrypto.createHash("sha256")
    .update(`${driver.length}:${driver}${bindingId}`)
    .digest("hex")}`;

/** A provider binding stores opaque bytes; only its adapter decodes or refreshes them. */
export const make = Effect.fn("ProviderCredentialStore.make")(function* (
  driver: string,
  bindingId: string,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const key = secretName(driver, bindingId);
  return {
    binding: { owner: "t3" as const, key },
    get: secrets.get(key),
    set: (credentials: Uint8Array) => secrets.set(key, credentials),
    remove: secrets.remove(key),
  };
});
