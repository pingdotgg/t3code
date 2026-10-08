/**
 * Cloudflare Workers deploy target for Octane.
 *
 * Alchemy preserves the native Octane compiler and client hooks, builds the
 * server for Workers, and generates `dist/server/worker.js`. No adapter is
 * required in `octane.config.ts`; existing Cloudflare adapters remain valid.
 *
 * Static assets are served first. Keep `notFoundHandling` unset so missing
 * assets reach server-rendered routes. Cloudflare bindings are available in
 * production and preview; native Octane HMR does not supply context.platform.
 */
import * as Effect from "effect/Effect";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import { buildCloudflare } from "./CloudflareBuild.ts";
import type { OctaneTarget, OctaneTargetConfig } from "./Octane.ts";

/** The `adapter.name` Octane's Cloudflare adapter declares. */
export const ADAPTER_NAME = "cloudflare";

/** The npm package providing Octane's Cloudflare adapter. */
export const ADAPTER_PACKAGE = "@octanejs/adapter-cloudflare";

/** The Worker entry the adapter emits into the server output directory. */
export const SERVER_ENTRY_FILE_NAME = "worker.js";

/**
 * Create the Cloudflare Workers {@link OctaneTarget}. See the module doc for
 * the seams. The config's `compatibilityDate`/`compatibilityFlags` are
 * carried for serve/deploy consumers; the build reuses Octane's native tooling.
 */
export const makeCloudflareTarget = (
  config: OctaneTargetConfig = {},
): OctaneTarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    adapterName: ADAPTER_NAME,
    adapterPackage: ADAPTER_PACKAGE,
    serverEntryFileName: SERVER_ENTRY_FILE_NAME,
    build: (context) =>
      buildCloudflare(context.root).pipe(
        Effect.mapError(
          (cause) =>
            new DeployTargetError({
              platform: "cloudflare",
              message: cause.message,
              cause,
            }),
        ),
      ),
  });

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeCloudflareTarget;

export default makeCloudflareTarget;
