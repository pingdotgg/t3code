import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Hard-coded secret value the integ test asserts against to prove the
 * Secret flows through the Worker's `env` async binding all the way to
 * the runtime `SecretsStoreSecret.get()`.
 */
export const SECRET_VALUE = "sk-async-binding-secret-value";

export const Store = Cloudflare.SecretsStore.Store("AsyncSecretBindingStore");

/**
 * A Secret in the store. Resolving it inside an Effect lets us declare it
 * directly on a Worker's `env`, which is the path under test — the Worker
 * provider must map it to a `secrets_store_secret` binding.
 */
export const ApiKey = Effect.gen(function* () {
  const store = yield* Store;
  return yield* Cloudflare.SecretsStore.Secret("AsyncBindingApiKey", {
    store,
    value: Redacted.make(SECRET_VALUE),
  });
});
