import { Random } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export const SecretsStore = Cloudflare.SecretsStore("PrPackageSecrets");

/** Random-generated bearer token. Yield to read `.text` from your stack. */
export const AuthTokenValue = Random("PrPackageAuthTokenValue");

/** Cloudflare Secret bound to the worker. Internal — yielded by `handler`. */
export const AuthToken = Effect.gen(function* () {
  const store = yield* SecretsStore;
  const value = yield* AuthTokenValue;
  return yield* Cloudflare.Secret("PrPackageAuthToken", {
    store,
    value: value.text,
  });
});
