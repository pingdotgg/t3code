import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, Profile } from "../Auth/Profile.ts";
import {
  NEON_AUTH_PROVIDER_NAME,
  type NeonAuthConfig,
  type NeonResolvedCredentials,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/neon";

const DEFAULT_BASE_URL = "https://console.neon.tech/api/v2";

export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* Profile;
      const auth = yield* getAuthProvider<
        NeonAuthConfig,
        NeonResolvedCredentials
      >(NEON_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as NeonAuthConfig),
        ),
        Effect.map((creds) => ({
          apiKey: creds.apiKey,
          apiBaseUrl: DEFAULT_BASE_URL,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve Neon credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
      );
    }),
  );
