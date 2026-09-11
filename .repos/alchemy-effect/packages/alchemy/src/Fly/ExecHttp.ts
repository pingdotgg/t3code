import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as sprites from "@distilled.cloud/fly-io/sprites";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Exec, type ExecRequest } from "./Exec.ts";
import { makeHttpSpriteBinding } from "./SpriteHttp.ts";

/**
 * HTTP implementation of {@link Exec}. Provide it on the
 * {@link Sprite}, {@link Service}, or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On a Sprite
 * ```typescript
 * Effect.gen(function* () {
 *   const exec = yield* Fly.Exec(Box);
 *   // ...
 * }).pipe(Effect.provide(Fly.ExecHttp))
 * ```
 *
 * @layer
 * @provides Fly.Exec
 */
export const ExecHttp = Layer.effect(
  Exec,
  Effect.suspend(() =>
    makeHttpSpriteBinding({
      makeClient: (auth, spriteName) =>
        Effect.fn("Fly.Exec")(function* (request: ExecRequest) {
          return yield* auth.authorize(
            sprites.execCommand({
              name: yield* spriteName,
              cmd: request.cmd,
              path: request.path,
              stdin: request.stdin,
              env: request.env,
              dir: request.dir,
              body: request.body,
            }),
          );
        }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
