import { Credentials, CredentialsFromEnv } from "@distilled.cloud/fly-io";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import { bindFlyApiToken } from "./Credentials.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Sprite } from "./Sprite.ts";

/**
 * Shared scaffolding for HTTP-backed Fly Sprite bindings.
 *
 * Captures ambient credentials during stack-eval (so Actions work
 * in-process) and `yield*`s the org token plus sprite `name` so
 * RuntimeContext.set runs. Runtime calls inside a deployed host read
 * `FLY_API_TOKEN` via {@link CredentialsFromEnv} after Platform copies
 * `runtimeContext.env` onto the host.
 *
 * NOT exported from `index.ts`.
 */
export const makeHttpSpriteBinding = <Client>(options: {
  makeClient: (auth: SpriteAuth, spriteName: Effect.Effect<string>) => Client;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (sprite: Sprite) {
      yield* bindFlyApiToken().pipe(Effect.provideContext(context));
      const name = yield* sprite.name;
      return options.makeClient(makeSpriteAuth(context), name);
    });
  });

export interface SpriteAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

export const makeSpriteAuth = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
): SpriteAuth => ({
  authorize: (eff) => {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return eff.pipe(
        Effect.provide(
          Layer.mergeAll(CredentialsFromEnv, FetchHttpClient.layer),
        ),
      );
    }
    return eff.pipe(Effect.provideContext(ambient));
  },
});
