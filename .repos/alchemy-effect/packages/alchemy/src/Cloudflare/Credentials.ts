import {
  apiKeyCredentials,
  apiTokenCredentials,
  Credentials,
  oauthCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthProvider.ts";

export { Credentials, fromEnv } from "@distilled.cloud/cloudflare/Credentials";

/**
 * Build a `Credentials` layer that resolves Cloudflare credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as CloudflareAuthConfig),
        ),
        Effect.map((creds) =>
          Match.value(creds).pipe(
            Match.when({ type: "apiToken" }, (c) =>
              apiTokenCredentials({
                apiToken: Redacted.value(c.apiToken),
              }),
            ),
            Match.when({ type: "apiKey" }, (c) =>
              apiKeyCredentials({
                apiKey: Redacted.value(c.apiKey),
                email: Redacted.value(c.email),
              }),
            ),
            Match.when({ type: "oauth" }, (c) =>
              oauthCredentials({
                accessToken: Redacted.value(c.accessToken),
                expiresAt: c.expires,
              }),
            ),
            Match.exhaustive,
          ),
        ),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Cloudflare credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
      );
    }),
  );
