import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials, type Config as CredentialsConfig } from "@distilled.cloud/gcp/Credentials";
import { GCPCredentialsError } from "@distilled.cloud/gcp/Errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { GCP_AUTH_PROVIDER_NAME, type GcpResolvedCredentials } from "./AuthProvider.ts";
import {
  cacheCredentials,
  fetchMetadataProject,
  fetchMetadataToken,
} from "./MetadataCredentials.ts";
import { mintAccessToken, parseServiceAccountKey } from "./Token.ts";

export {
  Credentials,
  CredentialsFromEnv,
  fromAccessToken,
  type Config as CredentialsConfig,
} from "@distilled.cloud/gcp/Credentials";

/**
 * Build a `Credentials` layer that resolves GCP credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Maps onto `@distilled.cloud/gcp`'s `{ accessToken, project }` shape.
 * Access tokens are minted from a service-account key when
 * `GOOGLE_APPLICATION_CREDENTIALS` is set.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    // Minted service-account tokens are re-resolved shortly before they
    // expire; supplied access tokens are cached for the process.
    lazyCredentials<GcpResolvedCredentials, GCPCredentialsError>()(
      GCP_AUTH_PROVIDER_NAME,
      (creds) => ({
        accessToken: creds.accessToken,
        project: creds.project,
        region: creds.region,
      }),
      { expiresAt: (creds) => creds.expiresAt },
    ),
  );

/**
 * GCP credential chain for Effect-native GKE workload pods (and local
 * processes): `GOOGLE_ACCESS_TOKEN`, then
 * `GOOGLE_APPLICATION_CREDENTIALS`, then the GCE metadata server
 * (Workload Identity). Minted tokens are cached until shortly before they
 * expire.
 */
export const fromChain = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      const cached = yield* cacheCredentials(
        Effect.gen(function* () {
          const envToken = yield* Config.option(Config.String("GOOGLE_ACCESS_TOKEN"));
          const envProject = yield* Config.option(
            Config.String("GOOGLE_PROJECT_ID").pipe(
              Config.orElse(() => Config.String("GOOGLE_CLOUD_PROJECT")),
            ),
          );
          if (Option.isSome(envToken)) {
            return {
              config: {
                accessToken: Redacted.make(envToken.value),
                project: Option.getOrUndefined(envProject),
              },
              expiresAt: undefined,
            };
          }

          const keyFile = yield* Config.option(Config.String("GOOGLE_APPLICATION_CREDENTIALS"));
          if (Option.isSome(keyFile)) {
            const raw = yield* fs.readFileString(keyFile.value).pipe(
              Effect.mapError((cause) =>
                ConfigError.make({
                  message: `Failed to read GOOGLE_APPLICATION_CREDENTIALS at ${keyFile.value}: ${cause.message}`,
                }),
              ),
            );
            const sa = yield* parseServiceAccountKey(raw).pipe(
              Effect.mapError((cause) =>
                ConfigError.make({
                  message: `Invalid GOOGLE_APPLICATION_CREDENTIALS JSON: ${cause.message}`,
                }),
              ),
            );
            const minted = yield* mintAccessToken(sa).pipe(
              Effect.mapError((cause) =>
                ConfigError.make({
                  message: `Failed to mint a Google access token from the service-account key: ${cause.message}`,
                }),
              ),
            );
            return {
              config: {
                accessToken: minted.accessToken,
                project: Option.getOrUndefined(envProject) ?? sa.project_id ?? minted.project,
              },
              expiresAt: minted.expirationMs,
            };
          }

          const token = yield* fetchMetadataToken(http);
          const project =
            Option.getOrUndefined(envProject) ??
            (yield* fetchMetadataProject(http).pipe(Effect.orElseSucceed(() => undefined)));
          return {
            config: { accessToken: token.accessToken, project },
            expiresAt: token.expiresAt,
          };
        }),
      );
      // Distilled `Credentials` is `Effect<Config>` (error `never`).
      return cached.pipe(Effect.orDie) as Effect.Effect<CredentialsConfig>;
    }),
  );
