import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** A provider binding stores opaque bytes; only its adapter decodes or refreshes them. */
export const make = Effect.fn("ProviderCredentialStore.make")(function* (
  driver: string,
  bindingId: string,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Hash the tuple so arbitrary bindings cannot escape or exceed a filename.
  const key = `provider-auth-${NodeCrypto.createHash("sha256")
    .update(`${driver.length}:${driver}${bindingId}`)
    .digest("hex")}`;
  return {
    binding: { owner: "t3" as const, key },
    get: secrets.get(key),
    set: (credentials: Uint8Array) => secrets.set(key, credentials),
    remove: secrets.remove(key),
  };
});
