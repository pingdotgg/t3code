import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CLOUDFLARE_AUTH_PROVIDER_NAME,
  type CloudflareResolvedCredentials,
} from "./Auth/AuthConfig.ts";
import { CloudflareEnvironment } from "./CloudflareEnvironmentService.ts";

export { CloudflareEnvironment } from "./CloudflareEnvironmentService.ts";

export const fromProfile = () =>
  Layer.effect(
    CloudflareEnvironment,
    // Building providers must work before Cloudflare is configured, so the
    // credentials resolve on first use. They carry the OAuth access token,
    // so cache only until it expires, like `Credentials.fromAuthProvider`.
    // `CloudflareEnvironment` is typed as never failing, so a failure dies.
    lazyCredentials<CloudflareResolvedCredentials>()(
      CLOUDFLARE_AUTH_PROVIDER_NAME,
      (creds) => creds,
      { expiresAt: (creds) => (creds.type === "oauth" ? creds.expires : undefined) },
    ).pipe(Effect.map(Effect.orDie)),
  );
