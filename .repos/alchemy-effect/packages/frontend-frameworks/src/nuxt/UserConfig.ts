/**
 * Config synthesis for driving Nuxt programmatically while keeping the
 * project's own `nuxt.config.ts` authoritative.
 *
 * A Nuxt project's `nuxt.config.ts` loads natively through `loadNuxt` (c12
 * resolves the file, its layers, and its modules exactly as `nuxi` would).
 * This package injects its configuration through two seams:
 *
 * 1. **`loadNuxt` overrides** — the highest-priority config layer. We put the
 *    deploy target's nitro preset and integration-level Nuxt overrides here.
 * 2. **The `nitro:config` hook** — runs when Nuxt initializes Nitro, after
 *    every module and layer has contributed. {@link enforceNitroConfig} is
 *    registered there and gets the last word on the keys this integration
 *    owns (the preset, and `cloudflare.deployConfig: false` — we never write
 *    a wrangler config into user projects).
 *
 * Hooks MUST be registered before `nuxt.ready()`: with `ready: true` the
 * hooks fire inside `loadNuxt` itself and a late registration misses them.
 * `Nuxt.ts` therefore always loads with `ready: false`.
 *
 * Conflict policy: the user's `nuxt.config.ts` may not select a different
 * deployment preset. Because `loadNuxt` overrides shadow the user's value in
 * the merged config, the user's raw value is read from the project's own
 * config layer (`nuxt.options._layers[0].config`) and a foreign preset fails
 * the build with an actionable error ({@link findPresetConflict}) instead of
 * being silently replaced — the user's nitro output would never be deployed.
 */

/** A minimal structural slice of a resolved nitro config (`NitroConfig`). */
export interface NitroConfigSlice extends Record<string, unknown> {
  preset?: string | undefined;
  cloudflare?: Record<string, unknown> | undefined;
  plugins?: Array<string> | undefined;
}

/** The structural slice of `nuxt.options._layers` entries this package reads. */
export interface NuxtConfigLayer {
  readonly cwd?: string | undefined;
  readonly config?:
    | {
        readonly nitro?: { readonly preset?: string | undefined } | undefined;
      }
    | undefined;
}

/**
 * Normalize a nitro preset name for comparison: nitro treats
 * `cloudflare_module`, `cloudflare-module`, and `cloudflareModule` as the
 * same preset (kebab/snake/camel-insensitive).
 */
export const normalizePresetName = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_-]+/g, "-")
    .toLowerCase();

/** Whether two preset names identify the same nitro preset. */
export const isSamePreset = (a: string, b: string): boolean =>
  normalizePresetName(a) === normalizePresetName(b);

export interface NuxtOverridesInput {
  /**
   * The deploy target's nitro preset (e.g. `"cloudflare_module"`), injected
   * as the highest-priority config layer AND re-enforced by
   * {@link enforceNitroConfig} after modules run. Omitted for the dev
   * server: nitro's dev flow runs its own Node dev preset — the deploy
   * preset only matters for `build`.
   */
  readonly nitroPreset?: string | undefined;
  /**
   * Integration-level Nuxt config overrides (`NuxtOptions.nuxtConfig`),
   * merged over the user's `nuxt.config.ts` (integration wins; c12/defu
   * performs the deep merge).
   */
  readonly nuxtConfig?: Record<string, unknown> | undefined;
  /** Absolute paths of nitro plugins to append (the dev-mode platform bridge). */
  readonly nitroPlugins?: ReadonlyArray<string> | undefined;
  /**
   * Paths nitro's bundler must INLINE (`nitro.externals.inline`). Injected
   * plugins that live under `node_modules` need this: nitro's externals
   * pass would otherwise keep them external, and an externalized plugin
   * resolves `nitropack/runtime` against the raw package — whose
   * `#nitro-internal-virtual/*` imports only exist inside the bundle.
   */
  readonly nitroExternalsInline?: ReadonlyArray<string> | undefined;
  /**
   * `runtimeConfig` injected over the integration overrides (the dev
   * platform's connect info rides here). Merged over any `runtimeConfig`
   * in `nuxtConfig`; c12 deep-merges the result with the user's own
   * `nuxt.config.ts` runtime config.
   */
  readonly runtimeConfig?: Record<string, unknown> | undefined;
}

/**
 * Synthesize the `overrides` object for `loadNuxt({ cwd, ready: false,
 * overrides })`. The user's `nuxt.config.ts` remains authoritative for
 * everything this integration does not own.
 */
export const makeNuxtOverrides = (
  input: NuxtOverridesInput,
): Record<string, unknown> => {
  const userNitro =
    input.nuxtConfig !== undefined && isPlainObject(input.nuxtConfig["nitro"])
      ? (input.nuxtConfig["nitro"] as Record<string, unknown>)
      : undefined;
  const userRuntimeConfig =
    input.nuxtConfig !== undefined &&
    isPlainObject(input.nuxtConfig["runtimeConfig"])
      ? (input.nuxtConfig["runtimeConfig"] as Record<string, unknown>)
      : undefined;
  const userExternals = isPlainObject(userNitro?.["externals"])
    ? (userNitro["externals"] as Record<string, unknown>)
    : undefined;
  const userVite =
    input.nuxtConfig !== undefined && isPlainObject(input.nuxtConfig["vite"])
      ? (input.nuxtConfig["vite"] as Record<string, unknown>)
      : undefined;
  return {
    ...input.nuxtConfig,
    // Warn-level vite default: rolldown-vite's native progress reporter
    // ("transforming...") writes straight to the fd, which corrupts
    // hosting-process reporters (e.g. alchemy-test) that can only intercept
    // JS-level writers. Integration-level `vite.logLevel` still wins.
    vite: { logLevel: "warn", ...userVite },
    nitro: {
      ...userNitro,
      ...(input.nitroPreset !== undefined
        ? { preset: input.nitroPreset }
        : undefined),
      ...(input.nitroPlugins !== undefined && input.nitroPlugins.length > 0
        ? {
            plugins: [
              ...(Array.isArray(userNitro?.["plugins"])
                ? (userNitro["plugins"] as Array<string>)
                : []),
              ...input.nitroPlugins,
            ],
          }
        : undefined),
      ...(input.nitroExternalsInline !== undefined &&
      input.nitroExternalsInline.length > 0
        ? {
            externals: {
              ...userExternals,
              inline: [
                ...(Array.isArray(userExternals?.["inline"])
                  ? (userExternals["inline"] as Array<unknown>)
                  : []),
                ...input.nitroExternalsInline,
              ],
            },
          }
        : undefined),
    },
    ...(input.runtimeConfig !== undefined
      ? { runtimeConfig: { ...userRuntimeConfig, ...input.runtimeConfig } }
      : undefined),
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Find a preset conflict in the project's own config layers: returns the
 * user's foreign preset name, or `undefined` when the user set no preset or
 * set (an alias of) the target's own. Layers are the project's config plus
 * any extended layers; only values the *project tree* contributed are
 * consulted — the merged `nuxt.options.nitro.preset` is already ours because
 * overrides shadow it.
 */
export const findPresetConflict = (
  layers: ReadonlyArray<NuxtConfigLayer> | undefined,
  targetPreset: string,
): string | undefined => {
  for (const layer of layers ?? []) {
    const preset = layer.config?.nitro?.preset;
    if (
      typeof preset === "string" &&
      preset.length > 0 &&
      !isSamePreset(preset, targetPreset)
    ) {
      return preset;
    }
  }
  return undefined;
};

/** The actionable error message for a user-configured foreign preset. */
export const presetConflictMessage = (
  userPreset: string,
  targetPreset: string,
): string =>
  `The project's nuxt.config sets \`nitro.preset: "${userPreset}"\`, but this integration ` +
  `deploys through the "${targetPreset}" preset — a "${userPreset}" build would never be ` +
  "deployed. Remove the `nitro.preset` (and any `NITRO_PRESET` env var) from the project " +
  "config and let the deploy target select the preset, or run the framework's own CLI for " +
  `a "${userPreset}" build outside this integration.`;

export interface EnforceNitroConfigOptions {
  /** The deploy target's nitro preset — always wins. */
  readonly preset: string;
  /**
   * Extra last-word mutation contributed by the deploy target (e.g. the
   * Cloudflare target's `cloudflare.deployConfig: false` and the user-entry
   * wiring). Runs after the preset is enforced.
   */
  readonly configure?: ((nitroConfig: NitroConfigSlice) => void) | undefined;
}

/**
 * The `nitro:config` hook body: enforce the keys this integration owns as
 * the last word, after user config, layers, and modules have all
 * contributed. Mutates `nitroConfig` in place (the hook contract).
 */
export const enforceNitroConfig = (
  nitroConfig: NitroConfigSlice,
  options: EnforceNitroConfigOptions,
): void => {
  nitroConfig.preset = options.preset;
  options.configure?.(nitroConfig);
};
