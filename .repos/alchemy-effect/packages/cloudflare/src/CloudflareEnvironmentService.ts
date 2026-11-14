import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { CloudflareResolvedCredentials } from "./Auth/AuthConfig.ts";

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareResolvedCredentials>
>()("Cloudflare::CloudflareEnvironment") {
  /**
   * The deploying account, for deploy-time code behind `__ALCHEMY_RUNTIME__`.
   * Its requirement is left off the type: the service is always present at
   * plan/deploy, and runtime hosts outside Cloudflare (e.g. an AWS Lambda
   * using an `*Http` binding) don't have it.
   */
  static current = CloudflareEnvironment.use(
    (env) => env,
  ) as unknown as Effect.Effect<CloudflareResolvedCredentials>;
  readonly kind = "Environment" as const;
}
