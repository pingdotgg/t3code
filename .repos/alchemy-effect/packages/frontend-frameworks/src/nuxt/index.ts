/**
 * `@alchemy.run/frontend-frameworks/nuxt` — Nuxt integration implementing framework-core's
 * `Framework` service, with the deploy target passed as a value (Cloudflare
 * Workers by default, via the `@alchemy.run/frontend-frameworks/nuxt/cloudflare` subpath
 * module).
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function that reads the harness's
 * cloudflare-target configuration (compatibility date/flags, the user worker
 * entry). Use {@link layer} directly for the fully-typed path with
 * Nuxt-specific options.
 *
 * This module (and `Nuxt.ts`) is target-agnostic by contract: it must not
 * import anything Cloudflare-specific. The Cloudflare half — the nitro
 * `cloudflare_module` preset selection and its wrangler-free config — lives
 * behind `@alchemy.run/frontend-frameworks/nuxt/cloudflare`.
 */
import type { Framework } from "../core/index.ts";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { layer, type NuxtOptions } from "./Nuxt.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  NUXT_KIT_SPECIFIER,
  readNitroOutput,
  SERVER_ENTRY_NAME,
  type NitroOutputDirs,
  type NuxtDevListener,
  type NuxtDevPlatform,
  type NuxtDevPlatformContext,
  type NuxtInstance,
  type NuxtKitModule,
  type NuxtNitroContext,
  type NuxtOptions,
  type NuxtTarget,
  type NuxtTargetConfig,
  type NuxtTargetInput,
} from "./Nuxt.ts";

export {
  enforceNitroConfig,
  findPresetConflict,
  isSamePreset,
  makeNuxtOverrides,
  normalizePresetName,
  presetConflictMessage,
  type EnforceNitroConfigOptions,
  type NitroConfigSlice,
  type NuxtConfigLayer,
  type NuxtOverridesInput,
} from "./UserConfig.ts";

/**
 * The structural subset of the e2e harness's cloudflare worker options this
 * package reads (`CloudflareVitePluginOptions`). Typed structurally so the
 * package does not depend on the harness.
 */
export interface HarnessWorkerOptions {
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: Array<string> | undefined;
  /** The USER's worker entry (the custom-entry carriage). */
  readonly main?: string | undefined;
  readonly worker?:
    | {
        /**
         * The worker's declared binding hooks — passed through to the
         * deploy target's dev platform wholesale (the Cloudflare target
         * serves them on `event.context.cloudflare.env` via
         * cloudflare-runtime's platform proxy).
         */
        readonly bindings?: ReadonlyArray<unknown> | undefined;
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
 * Map the harness's options onto {@link NuxtOptions}, preferring the
 * target-scoped carriage (`target.cloudflare.worker`) over the deprecated
 * top-level `vite` alias.
 */
export const fromHarnessOptions = (options: HarnessOptions): NuxtOptions => {
  const worker = options.target?.cloudflare?.worker ?? options.vite;
  return {
    compatibilityDate: worker?.compatibilityDate,
    compatibilityFlags: worker?.compatibilityFlags,
    main: worker?.main,
    dev: {
      bindings: worker?.worker?.bindings,
    },
  };
};

/**
 * The e2e-harness factory contract (`framework: "@alchemy.run/frontend-frameworks/nuxt"` in
 * `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options));

export default factory;
