import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "../Auth/Resolve.ts";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareAuthConfig,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthConfig.ts";

import { CloudflareEnvironment } from "./CloudflareEnvironmentService.ts";

export { CloudflareEnvironment } from "./CloudflareEnvironmentService.ts";

const CLOUDFLARE_ACCOUNT_ID = Config.String("CLOUDFLARE_ACCOUNT_ID");

export const fromEnv = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      const accountId = yield* CLOUDFLARE_ACCOUNT_ID.pipe(
        Config.option,
        Config.map(Option.getOrUndefined),
      );
      return { account: accountId } as any;
    }),
  );

export const fromProfile = () =>
  Layer.effect(
    CloudflareEnvironment,
    Effect.gen(function* () {
      // Building providers must work before Cloudflare is configured. Capture
      // the resolver's services now, but read profiles/credentials only when
      // a cloud operation actually evaluates this environment.
      const resolve = yield* resolveProviderConfig<
        CloudflareAuthConfig,
        CloudflareResolvedCredentials
      >(CLOUDFLARE_AUTH_PROVIDER_NAME).pipe(
        Effect.flatMap(({ resolve }) => resolve),
        deferUntilFirstUse,
      );
      return yield* resolve.pipe(
        orDieCredentialsUnavailable(CLOUDFLARE_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );
