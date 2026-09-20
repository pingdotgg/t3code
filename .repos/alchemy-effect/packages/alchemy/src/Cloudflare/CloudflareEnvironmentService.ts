import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { CloudflareResolvedCredentials } from "./Auth/AuthConfig.ts";

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareResolvedCredentials>
>()("Cloudflare::CloudflareEnvironment") {
  readonly kind = "Environment" as const;
}
