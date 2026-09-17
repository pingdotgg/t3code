import type {
  AppSecret,
  GetSecretError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Secret } from "./Secret.ts";

/**
 * Fetch one Fly.io App secret. The App and name are fixed by
 * `GetSecret(secret)`. Calls take no `app_name`.
 *
 *
 * ### Read a secret
 * Bind the client in init. Call it from `fetch` or an Action body.
 * Provide {@link GetSecretHttp}.
 *
 * Fly only returns plaintext from a Machine in the same App. From a
 * deploy-time Action you get metadata (name, digest, timestamps).
 *
 * **Example:** GetSecret
 * ```typescript
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const get = yield* Fly.GetSecret(ApiToken);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const got = yield* get().pipe(Effect.orDie);
 *         return HttpServerResponse.json({ name: got.name });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.GetSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 */
export interface GetSecret extends Binding.Service<
  GetSecret,
  "Fly.GetSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    () => Effect.Effect<AppSecret, GetSecretError, RuntimeContext>
  >
> {}

export const GetSecret = Binding.Service<GetSecret>("Fly.GetSecret");
