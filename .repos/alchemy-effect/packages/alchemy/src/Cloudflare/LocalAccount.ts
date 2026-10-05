import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProfileStore } from "../Auth/Profile.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  CloudflareAuthConfigSchema,
} from "./Auth/AuthConfig.ts";

/** Fallback identity when local dev has no configured Cloudflare account. */
export const LOCAL_ACCOUNT_ID = "00000000000000000000000000000000";

// Read identity only: expired OAuth credentials must not prevent local dev,
// and discovering an account must never authenticate or refresh a token.
export const localAccountId = Effect.gen(function* () {
  const accountId = (yield* Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(
    Config.withDefault(""),
  )).trim();
  if (accountId.length > 0) {
    return accountId;
  }

  const isCI = yield* Config.Boolean("CI").pipe(Config.withDefault(false));
  if (isCI) {
    return LOCAL_ACCOUNT_ID;
  }

  const profiles = Option.getOrUndefined(
    yield* Effect.serviceOption(ProfileStore),
  );
  if (profiles === undefined) {
    return LOCAL_ACCOUNT_ID;
  }

  const currentProfile = yield* profiles.current;
  const profile = yield* profiles.getProfile(currentProfile.name);
  const cloudflareConfig = profile?.providers[CLOUDFLARE_AUTH_PROVIDER_NAME];
  if (cloudflareConfig === undefined) {
    return LOCAL_ACCOUNT_ID;
  }

  const config = yield* Schema.decodeUnknownEffect(CloudflareAuthConfigSchema)(
    cloudflareConfig,
  );
  if ("accountId" in config) {
    return config.accountId;
  }

  return LOCAL_ACCOUNT_ID;
}).pipe(Effect.orDie);
