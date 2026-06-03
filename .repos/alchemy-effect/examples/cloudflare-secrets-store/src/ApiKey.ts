import { Random } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Store } from "./Store.ts";

/**
 * An API key secret in the Secrets Store.
 *
 * Uses `Random` to generate a stable random value that persists
 * across deploys (only regenerated if the resource is replaced).
 */
export const ApiKey = Effect.gen(function* () {
  const store = yield* Store;
  const secret = yield* Random("ApiKeyValue");

  return yield* Cloudflare.Secret("ApiKey", {
    store,
    value: secret.text,
  });
});
