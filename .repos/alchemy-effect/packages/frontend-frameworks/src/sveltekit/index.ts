/**
 * `@alchemy.run/frontend-frameworks/sveltekit` — SvelteKit integration implementing
 * framework-core's `Framework` service, with the deploy target passed as a
 * value (Cloudflare Workers by default, via the
 * `@alchemy.run/frontend-frameworks/sveltekit/cloudflare` subpath module).
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function that reads the harness's
 * cloudflare-target configuration (compatibility date/flags, worker bindings,
 * assets behavior). Use {@link layer} directly for the fully-typed path with
 * SvelteKit-specific options.
 *
 * This module (and `SvelteKit.ts`) is target-agnostic by contract: it must
 * not import anything Cloudflare-specific. The Cloudflare half — the
 * in-memory kit adapter fork, the workerd rolldown finishing pass, the
 * proxy-backed dev platform — lives behind
 * `@alchemy.run/frontend-frameworks/sveltekit/cloudflare`.
 */
import type { Framework } from "../core/index.ts";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { layer, type SvelteKitOptions } from "./SvelteKit.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  resolveExportTarget,
  type SvelteKitAdapter,
  type SvelteKitAdapterContext,
  type SvelteKitAdapterOptions,
  type SvelteKitAdapterResult,
  type SvelteKitOptions,
  type SvelteKitTarget,
  type SvelteKitTargetConfig,
  type SvelteKitTargetInput,
} from "./SvelteKit.ts";

export {
  CONFIG_PLUGIN_NAME,
  DEFAULT_VITE_CONFIG_FILES,
  flattenPluginOption,
  makeSvelteKitConfigPlugin,
  mergeKitOptions,
  SVELTEKIT_SETUP_PLUGIN_NAME,
  type SvelteKitConfigPluginOptions,
} from "./UserConfig.ts";

/**
 * The structural subset of the e2e harness's cloudflare worker options this
 * package reads (`CloudflareVitePluginOptions`). Typed structurally so the
 * package does not depend on the harness.
 */
export interface HarnessWorkerOptions {
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: Array<string> | undefined;
  readonly worker?:
    | {
        readonly bindings?: ReadonlyArray<unknown> | undefined;
        readonly assets?:
          | {
              readonly notFoundHandling?:
                | "none"
                | "404-page"
                | "single-page-application"
                | undefined;
            }
          | undefined;
      }
    | undefined;
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
 * Map the harness's options onto {@link SvelteKitOptions}, preferring the
 * target-scoped carriage (`target.cloudflare.worker`) over the deprecated
 * top-level `vite` alias. The worker's declared binding hooks are passed
 * through to the deploy target's dev platform wholesale (the Cloudflare
 * target serves them on `platform.env` via cloudflare-runtime's platform
 * proxy — resource bindings included, not just literal values).
 */
export const fromHarnessOptions = (
  options: HarnessOptions,
): SvelteKitOptions => {
  const worker = options.target?.cloudflare?.worker ?? options.vite;
  return {
    compatibilityDate: worker?.compatibilityDate,
    compatibilityFlags: worker?.compatibilityFlags,
    adapter: {
      notFoundHandling: worker?.worker?.assets?.notFoundHandling,
    },
    dev: {
      bindings: worker?.worker?.bindings,
    },
  };
};

/**
 * The e2e-harness factory contract (`framework: "@alchemy.run/frontend-frameworks/sveltekit"`
 * in `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options));

export default factory;
