import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/prisma";
import { deferUntilFirstUse, lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PRISMA_AUTH_PROVIDER_NAME, type PrismaResolvedCredentials } from "../AuthProvider.ts";
import { PrismaEnvironment } from "../PrismaEnvironment.ts";
import { resolveBaseUrl } from "./BaseUrl.ts";

export { Credentials } from "@distilled.cloud/prisma";

const toConfigError = (cause: { readonly message: string }) =>
  ConfigError.make({ message: `Invalid Prisma Management API URL: ${cause.message}` });

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
 * exercises local providers — from ever needing a Prisma token.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const credentials = yield* lazyCredentials<PrismaResolvedCredentials, ConfigError>()(
        PRISMA_AUTH_PROVIDER_NAME,
        (creds) => creds.serviceToken,
      );
      const baseUrl = yield* resolveBaseUrl.pipe(
        Effect.mapError(toConfigError),
        deferUntilFirstUse,
        Effect.flatMap(Effect.cached),
      );
      return Effect.all({ apiToken: credentials, apiBaseUrl: baseUrl });
    }),
  );
