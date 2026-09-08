import { Credentials, CredentialsFromEnv } from "@distilled.cloud/fly-io";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Sprite, SpriteBinding } from "./Sprite.ts";

/**
 * Shared scaffolding for HTTP-backed Fly Sprite bindings.
 *
 * Captures ambient `FLY_API_TOKEN` during stack-eval (so Actions work
 * in-process) and, when the host is a {@link Sprite}, {@link Service},
 * or {@link Machine}, injects `FLY_API_TOKEN` into the host env.
 * Runtime calls inside a deployed host read that env via
 * {@link CredentialsFromEnv}. Distilled mints a Sprites bearer from it.
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
      const name = yield* sprite.name as unknown as Effect.Effect<unknown>;
      const nameEff = toNameEffect(name);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          const token = yield* resolveToken(context);
          yield* host.bind`${sprite}`({
            env: { FLY_API_TOKEN: token },
          });
        }
      }

      return options.makeClient(makeSpriteAuth(context), nameEff);
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

const toNameEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) {
    return value as Effect.Effect<string>;
  }
  return Effect.die("Fly sprite binding expected a resolved sprite name");
};

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, SpriteBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Sprite" ||
    (value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const resolveToken = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
) =>
  Credentials.pipe(
    Effect.provideContext(ambient),
    Effect.flatMap((resolve) => resolve),
    Effect.map((cfg) => Redacted.value(cfg.apiKey)),
  );
