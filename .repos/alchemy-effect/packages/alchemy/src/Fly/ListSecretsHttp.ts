import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ListSecrets } from "./ListSecrets.ts";
import { makeHttpAppBinding } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link ListSecrets}. Provide it on the
 * {@link Service} or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On an Action
 * ```typescript
 * Effect.gen(function* () {
 *   const list = yield* Fly.ListSecrets(Site);
 *   // ...
 * }).pipe(Effect.provide(Fly.ListSecretsHttp))
 * ```
 *
 * @layer
 * @provides Fly.ListSecrets
 */
export const ListSecretsHttp = Layer.effect(
  ListSecrets,
  Effect.suspend(() =>
    makeHttpAppBinding({
      makeClient: (auth, appName) =>
        Effect.fn("Fly.ListSecrets")(function* () {
          return yield* auth.authorize(
            machines.listSecrets({
              app_name: yield* appName,
              // Names are enough for the binding; plaintext is env-injected.
              show_secrets: false,
            }),
          );
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
