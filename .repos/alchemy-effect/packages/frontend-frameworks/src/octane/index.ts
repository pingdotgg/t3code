/**
 * `@alchemy.run/frontend-frameworks/octane` — OctaneJS integration implementing
 * framework-core's `Framework` service, with the deploy target passed as a
 * value (Cloudflare Workers by default, via the
 * `@alchemy.run/frontend-frameworks/octane/cloudflare` subpath module).
 *
 * Octane wraps Vite: the project's own `vite build` (with
 * `@octanejs/vite-plugin` in its `vite.config.ts` and `adapter:
 * cloudflare()` in its `octane.config.ts`) already produces the deployable
 * output — client assets in `dist/client` and a self-contained Worker entry
 * at `dist/server/worker.js`. This package just drives that build
 * programmatically and maps the on-disk output onto the `BuildOutput`
 * contract; there are no adapter forks and no bundler-plugin injection.
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function that reads the harness's
 * cloudflare-target configuration (compatibility date/flags). Use
 * {@link layer} directly for the fully-typed path with Octane-specific
 * options.
 *
 * This module (and `Octane.ts`) is target-agnostic by contract: it must not
 * import anything Cloudflare-specific. The Cloudflare half — the adapter
 * validation constants — lives behind `@alchemy.run/frontend-frameworks/octane/cloudflare`.
 */
import type { Framework } from "../core/index.ts";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { layer, type OctaneOptions } from "./Octane.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  OCTANE_VITE_PLUGIN_SPECIFIER,
  readOctaneOutput,
  type OctaneOptions,
  type OctaneOutputDirs,
  type OctaneTarget,
  type OctaneTargetConfig,
  type OctaneTargetInput,
  type OctaneViteDevServer,
  type OctaneViteModule,
  type OctaneVitePluginModule,
  type ResolvedOctaneConfigSlice,
} from "./Octane.ts";

/**
 * The structural subset of the e2e harness's cloudflare worker options this
 * package reads (`CloudflareVitePluginOptions`). Typed structurally so the
 * package does not depend on the harness.
 */
export interface HarnessWorkerOptions {
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: Array<string> | undefined;
}

/**
 * The structural subset of the e2e harness's `Options` this package reads.
 * The harness carries cloudflare configuration target-scoped
 * (`target.cloudflare.worker`); the top-level `vite` field is the harness's
 * deprecated alias for the same shape (target-scoped wins).
 */
export interface HarnessOptions {
  readonly target?:
    | {
        readonly cloudflare?:
          | {
              readonly worker?: HarnessWorkerOptions | undefined;
            }
          | undefined;
      }
    | undefined;
  /** @deprecated Harness alias for `target.cloudflare.worker`. */
  readonly vite?: HarnessWorkerOptions | undefined;
}

/**
 * Map the harness's options onto {@link OctaneOptions}, preferring the
 * target-scoped carriage (`target.cloudflare.worker`) over the deprecated
 * top-level `vite` alias.
 */
export const fromHarnessOptions = (options: HarnessOptions): OctaneOptions => {
  const worker = options.target?.cloudflare?.worker ?? options.vite;
  return {
    compatibilityDate: worker?.compatibilityDate,
    compatibilityFlags: worker?.compatibilityFlags,
  };
};

/**
 * The e2e-harness factory contract (`framework: "@alchemy.run/frontend-frameworks/octane"`
 * in `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options));

export default factory;
