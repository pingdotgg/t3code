/**
 * `@alchemy.run/frontend-frameworks/octane/cloudflare` — the Cloudflare Workers deploy target
 * for `@alchemy.run/frontend-frameworks/octane`.
 *
 * Octane's Cloudflare story is its own `@octanejs/adapter-cloudflare`: after
 * `vite build` produces the client bundle and the self-contained server
 * bundle (`dist/server/entry.js`, built with `noExternal: true` and only
 * `node:` externals for workerd's `nodejs_compat`), the adapter's adapt()
 * pass emits the module Worker entry at `dist/server/worker.js` — already
 * workerd ESM, so this target needs no plugin injection and no finishing
 * pass. What it owns:
 *
 * - **`adapterName` / `adapterPackage`** — the project's `octane.config.ts`
 *   must select `adapter: cloudflare()` from `@octanejs/adapter-cloudflare`;
 *   the framework half validates this and fails actionably otherwise
 *   (wrangler-free doctrine: the adapter is in-memory config, and no
 *   `wrangler.json` is read or written anywhere).
 * - **`serverEntryFileName`** — `worker.js`, the adapter's emitted entry;
 *   becomes `serverModules[0]` of the `BuildOutput`.
 * - **`bundle`** — workerd resolve conditions and the `cloudflare:`
 *   externals, for callers that post-process server code.
 *
 * Octane serves `dist/client` asset-first; only misses reach the Worker, so
 * deployments keep `notFoundHandling` unset (`"none"`) — both
 * `"single-page-application"` and `"404-page"` would prevent
 * browser-navigation misses from reaching SSR.
 *
 * Dev note: Octane's Vite dev middleware supplies no request-scoped
 * `context.platform` (an upstream limitation), so there is no `devPlatform`
 * seam yet — Cloudflare bindings are live/preview-only.
 */
import { makeDeployTarget } from "../core/index.ts";
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
 * carried for serve/deploy consumers; the build itself is entirely Octane's.
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
  });

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeCloudflareTarget;

export default makeCloudflareTarget;
