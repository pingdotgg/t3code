import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { reifyBoundConfigProvider } from "../../Runtime.ts";
import cloudflare_workers from "./cloudflare_workers.ts";

/**
 * A `ConfigProvider` backed by the running Worker's environment.
 *
 * Values that were auto-bound by the deploy-time `Config` interceptor
 * arrive in the env as `{"_tag":"Redacted","value":...}` markers; they are
 * reified back to their raw source value before `Config` schemas decode
 * them, matching the provider the Worker bridge installs by default.
 */
export const WorkerConfigProvider = () =>
  cloudflare_workers.pipe(
    Effect.map(({ env }) =>
      reifyBoundConfigProvider(
        ConfigProvider.fromUnknown(env),
        env as Record<string, unknown>,
      ),
    ),
  );
