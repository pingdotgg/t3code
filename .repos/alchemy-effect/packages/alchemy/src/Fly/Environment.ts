import type { Config } from "@distilled.cloud/fly-io";
import { Credentials } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

export class FlyOrgNotFound extends Data.TaggedError("Fly.OrgNotFound")<{
  message: string;
}> {}

/**
 * Fully-resolved Fly.io environment for a stack.
 *
 * `{ apiKey, apiBaseUrl }` comes from distilled `Credentials`. `orgSlug` is
 * the current token's organization (`getCurrentToken` → `tokens[0].org_slug`),
 * cached for the process. Resolve it inside lifecycle operations with
 * `FlyEnvironment.current`.
 */
export type FlyEnvironmentShape = Config & {
  readonly orgSlug: string;
};

export class FlyEnvironment extends Context.Service<
  FlyEnvironment,
  Effect.Effect<FlyEnvironmentShape>
>()("Fly::Environment") {
  static current = FlyEnvironment.use((env) => env);
  readonly kind = "Environment" as const;
}

/**
 * Discover the current token's organization slug via `getCurrentToken`.
 * Used by {@link fromCredentials} and by {@link Catalog.currentOrgSlug}.
 */
export const resolveOrgSlug = Effect.fn(function* () {
  const info = yield* machines.getCurrentToken({});
  const orgSlug = info.tokens?.[0]?.org_slug;
  if (orgSlug === undefined || orgSlug.length === 0) {
    return yield* new FlyOrgNotFound({
      message: "Fly current token did not include an organization slug.",
    });
  }
  return orgSlug;
});

/**
 * Build a `FlyEnvironment` layer from the distilled `Credentials`
 * service. Provide this after `Credentials.fromAuthProvider()`.
 *
 * `orgSlug` is resolved from `getCurrentToken` and cached so App.list /
 * Catalog do not re-hit `/tokens/current` on every call.
 */
export const fromCredentials = () =>
  Layer.effect(
    FlyEnvironment,
    Effect.gen(function* () {
      const creds = yield* Credentials;
      const http = yield* HttpClient.HttpClient;
      return yield* creds.pipe(
        Effect.flatMap((resolved) =>
          resolveOrgSlug().pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Credentials, creds),
                Layer.succeed(HttpClient.HttpClient, http),
              ),
            ),
            Effect.map((orgSlug) => ({
              ...resolved,
              orgSlug,
            })),
          ),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
