/**
 * Config synthesis for driving SolidStart programmatically while keeping the
 * project's own `vite.config.*` authoritative.
 *
 * SolidStart 2's `solidStart()` is a plain Vite plugin: it declares the
 * `client` / `ssr` environments and a `builder.buildApp` that builds both.
 * The server half — turning the SSR bundle into a deployable server — is
 * `@solidjs/vite-plugin-nitro-2`, a second Vite plugin whose `buildApp`
 * replaces SolidStart's and runs nitro over the emitted SSR bundle.
 *
 * That plugin takes its nitro configuration as a plain argument and always
 * passes a `preset` down to nitro (its own default is `"node-server"`), so
 * neither `NITRO_PRESET` nor a `nitro.config.ts` can override it. The only
 * seam that gets the last word is the plugin instance itself — so this
 * integration constructs it:
 *
 * 1. The project's `vite.config.*` loads natively (its `solidStart()` and any
 *    other plugins are untouched).
 * 2. The integration APPENDS its own `nitroV2Plugin(...)` instance — loaded
 *    from the *project's* `node_modules` — through vite's inline config.
 *    Inline plugins are concatenated after the config file's, and vite merges
 *    plugin `config()` results in order, so the appended instance's
 *    `builder.buildApp` (and therefore its nitro config) wins.
 * 3. {@link resolveNitroConfig} assembles that nitro config: the deploy
 *    target's preset is enforced last, after the caller's `nitro` overrides
 *    and the target's own {@link NitroConfigSlice} pass.
 *
 * Conflict policy: a project that registers `nitroV2Plugin` in its own
 * `vite.config.*` would have its nitro options silently dropped (our
 * appended instance replaces its `buildApp`), so the build fails with
 * {@link pluginConflictMessage} instead. Nitro options belong on the
 * integration (`nitro: { ... }`), which forwards them.
 *
 * The preset-name helpers are duplicated from the Nuxt integration rather
 * than shared: they are pure string functions, and a shared module would
 * couple two independent framework packages through framework-core's public
 * surface for ~20 lines.
 */

/** A minimal structural slice of a nitro config (`NitroConfig`). */
export interface NitroConfigSlice extends Record<string, unknown> {
  preset?: string | undefined;
  rootDir?: string | undefined;
  /** Nitro's work directory. Forced under `rootDir` so fixture clones don't share a parent-workspace cache. */
  buildDir?: string | undefined;
  awsLambda?: Record<string, unknown> | undefined;
  output?: NitroOutputConfigSlice | undefined;
}

/** The `output` slice of a nitro config this integration reads. */
export interface NitroOutputConfigSlice {
  dir?: string | undefined;
  serverDir?: string | undefined;
  publicDir?: string | undefined;
}

/** The plugin name `@solidjs/vite-plugin-nitro-2` registers. */
export const NITRO_PLUGIN_NAME = "solid-start-vite-plugin-nitro";

/**
 * Normalize a nitro preset name for comparison: nitro treats `aws_lambda`,
 * `aws-lambda`, and `awsLambda` as the same preset (kebab/snake/camel
 * insensitive).
 */
export const normalizePresetName = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_-]+/g, "-")
    .toLowerCase();

/** Whether two preset names identify the same nitro preset. */
export const isSamePreset = (a: string, b: string): boolean =>
  normalizePresetName(a) === normalizePresetName(b);

/** The actionable error message for a caller-configured foreign preset. */
export const presetConflictMessage = (
  userPreset: string,
  targetPreset: string,
): string =>
  `The integration was given \`nitro.preset: "${userPreset}"\`, but this deploy target ` +
  `builds through the "${targetPreset}" preset — a "${userPreset}" build would never be ` +
  "deployed. Remove `nitro.preset` and let the deploy target select it, or run the " +
  `framework's own CLI for a "${userPreset}" build outside this integration.`;

/** The actionable error message for a project-registered nitro plugin. */
export const pluginConflictMessage = (): string =>
  "The project's vite config registers `nitroV2Plugin()` from " +
  "`@solidjs/vite-plugin-nitro-2`. This integration appends its own instance so the " +
  "deploy target owns the nitro preset, which would silently discard the project's " +
  "nitro options. Remove `nitroV2Plugin()` from the vite config and pass its options " +
  "to the integration instead (`nitro: { ... }`, e.g. `nitro: { prerender: { crawlLinks: true } }`).";

export interface ResolveNitroConfigInput {
  /** The deploy target's nitro preset — always the last word. */
  readonly preset: string;
  /** Absolute project root, forwarded to nitro as `rootDir`. */
  readonly rootDir: string;
  /** Caller-supplied nitro overrides (the integration's `nitro` option). */
  readonly nitro?: Record<string, unknown> | undefined;
  /**
   * Extra last-word mutation contributed by the deploy target (e.g. the AWS
   * target's `awsLambda.streaming`). Runs after the preset is enforced.
   */
  readonly configure?: ((nitroConfig: NitroConfigSlice) => void) | undefined;
}

/**
 * Assemble the nitro config handed to the appended `nitroV2Plugin(...)`
 * instance: the caller's overrides first, then the owned keys (`preset`,
 * `rootDir`) enforced over them, then the deploy target's pass.
 */
export const resolveNitroConfig = (
  input: ResolveNitroConfigInput,
): NitroConfigSlice => {
  const config: NitroConfigSlice = { ...input.nitro };
  config.preset = input.preset;
  config.rootDir = input.rootDir;
  // Keep nitro's `.nitro` cache inside this project. A fixture clone
  // resolves nitro from the parent workspace; nitro's default cache then
  // lands in that workspace and leaks other tests' traced modules.
  config.buildDir = `${input.rootDir}/.nitro`;
  input.configure?.(config);
  return config;
};

/**
 * The caller's foreign preset, or `undefined` when none was given or it is
 * (an alias of) the target's own.
 */
export const findPresetConflict = (
  nitro: Record<string, unknown> | undefined,
  targetPreset: string,
): string | undefined => {
  const preset = nitro?.["preset"];
  return typeof preset === "string" &&
    preset.length > 0 &&
    !isSamePreset(preset, targetPreset)
    ? preset
    : undefined;
};

/**
 * Resolve the absolute nitro output directories for a build at `root`,
 * honoring an `output` override on the nitro config. Mirrors nitro's own
 * defaults (`.output`, `.output/server`, `.output/public`).
 */
export const resolveNitroOutputDirs = (
  config: NitroConfigSlice,
  root: string,
  resolve: (...segments: Array<string>) => string,
): { dir: string; serverDir: string; publicDir: string } => {
  const dir = resolve(root, config.output?.dir ?? ".output");
  return {
    dir,
    serverDir: resolve(dir, config.output?.serverDir ?? "server"),
    publicDir: resolve(dir, config.output?.publicDir ?? "public"),
  };
};

/** Marker set on the plugin instances this integration appends. */
const INJECTED = Symbol.for(
  "@alchemy.run/frontend-frameworks/solidstart/injected",
);

/** Flatten a vite `plugins` value (nested arrays, falsy entries) to objects. */
const flattenPlugins = (
  value: unknown,
  out: Array<Record<string | symbol, unknown>>,
): void => {
  if (Array.isArray(value)) {
    for (const entry of value) flattenPlugins(entry, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    out.push(value as Record<string | symbol, unknown>);
  }
};

/** Stamp every plugin object this integration created so it is recognizable. */
export const markInjectedPlugins = <T>(plugins: T): T => {
  const flat: Array<Record<string | symbol, unknown>> = [];
  flattenPlugins(plugins, flat);
  for (const plugin of flat) {
    plugin[INJECTED] = true;
  }
  return plugins;
};

/**
 * Whether a vite `plugins` value contains a nitro plugin instance this
 * integration did NOT create (see {@link pluginConflictMessage}).
 */
export const hasForeignNitroPlugin = (plugins: unknown): boolean => {
  const flat: Array<Record<string | symbol, unknown>> = [];
  flattenPlugins(plugins, flat);
  return flat.some(
    (plugin) =>
      plugin["name"] === NITRO_PLUGIN_NAME && plugin[INJECTED] !== true,
  );
};
