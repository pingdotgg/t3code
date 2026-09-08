import type {
  AppSecrets,
  ListSecretsError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { App } from "./App.ts";

/**
 * List Fly.io App secrets. Scoped to an {@link App}. Fly's list API
 * is `GET /apps/{app}/secrets`, not a single Secret.
 *
 *
 * ### List this App
 * The App is fixed by `ListSecrets(app)`. Calls take no `app_name`.
 * Provide {@link ListSecretsHttp}.
 *
 * Plaintext is only returned from inside a Machine in the same App.
 * From a deploy-time Action you get metadata (name, digest,
 * timestamps).
 *
 * **Example:** ListSecrets
 * ```typescript
 * const list = yield* Fly.ListSecrets(Site);
 * const { secrets } = yield* list();
 * ```
 *
 * ### List another App
 * From an Action, the org `FLY_API_TOKEN` can list any App in the
 * org. `ListSecrets(other)` is how you reach across Apps.
 *
 * From a Machine, deploy tokens are per-App. Mixing Apps on one host
 * shares one `FLY_API_TOKEN` and is not supported.
 *
 * **Example:** Cross-app from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const list = yield* Fly.ListSecrets(Other);
 *
 *     return Effect.fn(function* () {
 *       const { secrets } = yield* list();
 *       return secrets;
 *     });
 *   }).pipe(Effect.provide(Fly.ListSecretsHttp)),
 * );
 * ```
 *
 * @binding
 */
export interface ListSecrets extends Binding.Service<
  ListSecrets,
  "Fly.ListSecrets",
  (
    app: App,
  ) => Effect.Effect<
    () => Effect.Effect<AppSecrets, ListSecretsError, RuntimeContext>
  >
> {}

export const ListSecrets = Binding.Service<ListSecrets>("Fly.ListSecrets");
