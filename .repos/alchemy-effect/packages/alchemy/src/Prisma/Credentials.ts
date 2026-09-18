import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/prisma";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { ProfileStore } from "../Auth/Profile.ts";
import { PrismaEnvironment, fromProfile } from "./PrismaEnvironment.ts";

export { Credentials } from "@distilled.cloud/prisma";

const toConfigError = (cause: unknown) =>
  new ConfigError({
    message: `Failed to resolve Prisma credentials: ${
      (cause as { message?: string })?.message ?? String(cause)
    }`,
  });

/**
 * Bridge an already-resolved {@link PrismaEnvironment} into the distilled
 * `Credentials` service. Use this when the environment is provided by the
 * caller (tests, standalone operation helpers).
 */
export const fromEnvironment = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const env = yield* PrismaEnvironment;
      return Effect.succeed({
        apiToken: env.serviceToken,
        apiBaseUrl: env.baseUrl,
      });
    }),
  );

/**
 * Resolve Prisma credentials lazily from the configured auth profile.
 *
 * The `Credentials` service holds an *effect*, so nothing is resolved until
 * the first API operation runs. That keeps `alchemy dev` — which only
 * exercises local providers — from ever needing a Prisma token, matching the
 * deferred behavior of the client layer this replaces.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const authProviders = yield* AuthProviders;
      const profile = yield* ProfileStore;
      const environment = Layer.buildWithScope(
        fromProfile().pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AuthProviders, authProviders),
              Layer.succeed(ProfileStore, profile),
            ),
          ),
        ),
        scope,
      ).pipe(Effect.map((context) => Context.get(context, PrismaEnvironment)));

      return yield* Effect.cached(
        environment.pipe(
          Effect.map((env) => ({
            apiToken: env.serviceToken,
            apiBaseUrl: env.baseUrl,
          })),
          Effect.mapError(toConfigError),
        ),
      );
    }),
  );
