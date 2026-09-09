/**
 * Support for projects with their own `vite.config.ts`.
 *
 * A normal SvelteKit v3 project carries all of its configuration in the Vite
 * config file: `svelte.config.js` is gone (kit's own `plugin_root` throws if
 * one exists on disk), and kit options — adapter, aliases, preprocess,
 * prerender entries — are passed directly to the `sveltekit(...)` plugin call
 * inside `vite.config.ts`.
 *
 * This package must honor that file natively (the user's Vite plugins, kit
 * options, and Vite settings all apply) while still injecting the deploy
 * target's adapter — WITHOUT constructing a second `sveltekit()` plugin
 * instance next to the user's.
 *
 * Mechanism: `sveltekit(config)` validates the config eagerly and exposes it
 * as `api.options` on the `vite-plugin-sveltekit-setup` plugin, but only
 * *processes* it (deriving the `kit` config every later hook closes over)
 * inside that plugin's `config: { order: "pre" }` hook. Vite runs config
 * hooks in hook-`order` groups, and within a group in `enforce`-sorted plugin
 * order — so an `enforce: "pre"` inline plugin whose config hook is also
 * `order: "pre"` runs BEFORE kit's setup hook (inline plugins append after
 * file plugins, and the file's only other `pre`-enforced kit plugin,
 * `vite-plugin-sveltekit-resolve-svelte-config`, merely asserts no
 * `svelte.config.js` exists). Mutating `api.options` at that point is
 * therefore exactly as authoritative as having passed the options to
 * `sveltekit(...)` directly.
 *
 * The injected plugin:
 *
 * 1. flattens the config's plugin option (awaiting the promises `sveltekit()`
 *    returns) and finds `vite-plugin-sveltekit-setup`;
 * 2. fails with a descriptive error when it is absent (a `vite.config.ts`
 *    without `sveltekit()` is not a SvelteKit project — we cannot add the
 *    plugin from a config hook, Vite ignores plugins injected there);
 * 3. merges the integration-level kit options (`SvelteKitOptions.kit`) over
 *    the user's — integration options win, mirroring Vite's inline-over-file
 *    precedence;
 * 4. replaces the adapter with the deploy target's, warning when the user
 *    had declared their own: the adapter is the deploy-packaging seam (its
 *    output is what the target's finishing pass re-bundles and what alchemy
 *    uploads), so a foreign adapter's output would simply never be deployed.
 *    The user's file itself is untouched — running plain `vite build`
 *    outside this integration still uses their adapter.
 */
import type { Adapter } from "@sveltejs/kit";
import type * as ViteModule from "vite";

/** The kit plugin that exposes the validated svelte config as `api.options`. */
export const SVELTEKIT_SETUP_PLUGIN_NAME = "vite-plugin-sveltekit-setup";

/** The name of the injected adapter/config plugin. */
export const CONFIG_PLUGIN_NAME = "distilled-sveltekit-config";

/**
 * The Vite config file names this package probes for (mirrors Vite's
 * `DEFAULT_CONFIG_FILES`) to decide between honoring a user config natively
 * and the fully-programmatic fallback.
 */
export const DEFAULT_VITE_CONFIG_FILES: ReadonlyArray<string> = [
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "vite.config.cjs",
  "vite.config.mts",
  "vite.config.cts",
];

/** The shape of kit's setup-plugin `api` (structural — kit doesn't export it). */
interface SetupPluginApi {
  readonly options?: Record<string, unknown>;
}

/**
 * Flatten Vite's `PluginOption` tree (nested arrays, promises, falsy holes)
 * into a plain plugin list — the same normalization Vite itself performs
 * before running config hooks.
 */
export const flattenPluginOption = async (
  option: ViteModule.PluginOption,
): Promise<Array<ViteModule.Plugin>> => {
  const resolved = await option;
  if (resolved === null || resolved === undefined || resolved === false) {
    return [];
  }
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map(flattenPluginOption));
    return nested.flat();
  }
  return [resolved as ViteModule.Plugin];
};

/**
 * The top-level svelte options `sveltekit(config)` consumes at construction
 * time (before any Vite hook runs). They cannot be applied by mutating
 * `api.options` afterwards — `vite-plugin-svelte` was already instantiated
 * with them — so the injector warns instead of silently dropping them.
 */
const CONSTRUCTION_TIME_KEYS = [
  "extensions",
  "compilerOptions",
  "vitePlugin",
  "preprocess",
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Merge integration-level kit overrides over the user's validated kit config
 * (two levels deep: nested plain objects merge key-by-key so validated
 * defaults survive, everything else replaces).
 */
export const mergeKitOptions = (
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void => {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      target[key] = { ...existing, ...value };
    } else {
      target[key] = value;
    }
  }
};

export interface SvelteKitConfigPluginOptions {
  /** The deploy target's adapter — always wins over a user-declared adapter. */
  readonly adapter: Adapter;
  /**
   * Integration-level kit options (`SvelteKitOptions.kit`) merged over the
   * user's `sveltekit(...)` options (integration wins).
   */
  readonly kit?: Record<string, unknown> | undefined;
  /** Warning sink. @default console.warn */
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * The inline Vite plugin injected when the project has its own
 * `vite.config.ts`: locates the user's `sveltekit()` plugin and installs the
 * deploy target's adapter (plus integration-level kit options) into its
 * config before kit processes it. See the module doc for why the ordering is
 * sound.
 */
export const makeSvelteKitConfigPlugin = (
  options: SvelteKitConfigPluginOptions,
): ViteModule.Plugin => {
  const warn =
    options.warn ??
    ((message: string) => console.warn(`[${CONFIG_PLUGIN_NAME}] ${message}`));
  return {
    name: CONFIG_PLUGIN_NAME,
    enforce: "pre",
    config: {
      order: "pre",
      handler: async (config) => {
        const plugins = await flattenPluginOption(config.plugins);
        const setup = plugins.find(
          (plugin) => plugin.name === SVELTEKIT_SETUP_PLUGIN_NAME,
        );
        if (setup === undefined) {
          throw new Error(
            "The project's Vite config does not register the SvelteKit plugin. " +
              "Add `sveltekit()` (from `@sveltejs/kit/vite`) to the `plugins` array of " +
              "your Vite config file, or remove the config file to let the integration " +
              "configure Vite programmatically.",
          );
        }
        const svelteConfig = (setup.api as SetupPluginApi | undefined)?.options;
        const nestedKit = svelteConfig?.["kit"];
        const kit = isPlainObject(nestedKit) ? nestedKit : svelteConfig;

        if (!isPlainObject(kit)) {
          throw new Error(
            `The "${SVELTEKIT_SETUP_PLUGIN_NAME}" plugin does not expose its config as ` +
              "`api.options` or `api.options.kit` — the installed @sveltejs/kit version " +
              "is incompatible with this integration's adapter injection.",
          );
        }
        if (options.kit !== undefined) {
          const { applicable, constructionTime } = Object.entries(
            options.kit,
          ).reduce<{
            applicable: Record<string, unknown>;
            constructionTime: Array<string>;
          }>(
            (acc, [key, value]) => {
              if (CONSTRUCTION_TIME_KEYS.includes(key)) {
                acc.constructionTime.push(key);
              } else {
                acc.applicable[key] = value;
              }
              return acc;
            },
            { applicable: {}, constructionTime: [] },
          );
          if (constructionTime.length > 0) {
            warn(
              `The kit option(s) ${constructionTime.map((key) => `"${key}"`).join(", ")} ` +
                "cannot be injected when the project has its own Vite config file — " +
                "pass them to the `sveltekit(...)` call in the config file instead.",
            );
          }
          mergeKitOptions(kit, applicable);
        }
        const userAdapter = kit["adapter"];
        if (userAdapter !== null && userAdapter !== undefined) {
          const name =
            isPlainObject(userAdapter) &&
            typeof userAdapter["name"] === "string"
              ? userAdapter["name"]
              : "unknown";
          warn(
            `Replacing the adapter declared in the project's Vite config ("${name}") with ` +
              "the deploy target's adapter: the deploy target owns build packaging, so a " +
              "user-declared adapter's output would never be deployed. Remove the " +
              "`adapter` option from `sveltekit(...)` to silence this warning " +
              "(plain `vite build` outside this integration still uses it).",
          );
        }
        kit["adapter"] = options.adapter;
      },
    },
  };
};
