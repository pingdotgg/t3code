import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { GetSecret } from "./GetSecret.ts";
import { makeHttpSecretBinding } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link GetSecret}. Provide it on the
 * {@link Service} or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const get = yield* Fly.GetSecret(ApiToken);
 *   // ...
 * }).pipe(Effect.provide(Fly.GetSecretHttp))
 * ```
 *
 * @layer
 * @provides Fly.GetSecret
 */
export const GetSecretHttp = Layer.effect(
  GetSecret,
  Effect.suspend(() =>
    makeHttpSecretBinding({
      makeClient: (auth, appName, secretName) =>
        Effect.fn("Fly.GetSecret")(function* () {
          const name = yield* secretName;
          if (globalThis.__ALCHEMY_RUNTIME__) {
            // Fly injects App secrets as env vars on the Machine. Prefer
            // that over getSecret — org tokens still cannot read plaintext
            // from outside the App, and the env is already the source of
            // truth once the secret exists.
            const fromEnv = yield* Config.redacted(name).pipe(
              Effect.map((value) => ({
                name,
                value: Redacted.value(value),
              })),
              Effect.catch(() => Effect.succeed(undefined)),
            );
            if (fromEnv !== undefined) return fromEnv;
          }
          return yield* auth.authorize(
            machines.getSecret({
              app_name: yield* appName,
              secret_name: name,
              show_secrets: globalThis.__ALCHEMY_RUNTIME__ === true,
            }),
          );
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
