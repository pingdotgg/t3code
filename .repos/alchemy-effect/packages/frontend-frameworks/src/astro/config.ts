import { existsSync } from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import { FrameworkError } from "../core/Framework.ts";
import { loadProjectModule, resolveProjectPackageDirectory } from "../core/Loader.ts";
import { usesCloudflareCacheProvider } from "./cache.ts";

/** Astro's own config discovery list, in its lookup order. */
const CONFIG_FILES = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts"];

/** The `output` an Astro config can declare. */
export type AstroOutput = "server" | "static";

export interface ReadConfigOutputOptions {
  /** Directory a relative {@link rootDir} resolves against. Defaults to the process working directory. */
  readonly cwd?: string | undefined;
  /** Project root. Defaults to {@link cwd}. */
  readonly rootDir?: string | undefined;
  /**
   * Path to an alternate Astro config file, relative to {@link rootDir}.
   * Defaults to astro's own config discovery.
   */
  readonly config?: string | undefined;
}

interface ViteModule {
  readonly loadConfigFromFile: (
    configEnv: { command: "build"; mode: string },
    configFile: string,
    configRoot: string,
    logLevel: "silent",
    customLogger: undefined,
    configLoader: "runner",
  ) => Promise<{ readonly config: unknown } | null>;
}

/** The deploy-relevant settings a project's `astro.config.*` declares. */
export interface AstroConfigSettings {
  /** The declared `output`, or `undefined` when the file does not set one. */
  readonly output: AstroOutput | undefined;
  /**
   * Whether the config routes caching through the Cloudflare cache provider
   * (`cache: { provider: cacheCloudflare() }`), which needs Workers Cache
   * enabled on the Worker.
   */
  readonly workerCache: boolean;
}

/**
 * Read the deploy-relevant settings of a project's `astro.config.*` file.
 * Without a config file, `output` is `undefined` and `workerCache` is
 * `false`.
 *
 * Deploy composites call this at plan time: whether a site is assets-only
 * decides which resources exist, and Astro gives no way to tell an explicit
 * file-level `output: "static"` apart from its own `"static"` default once
 * the config resolves. The file loads the way Astro loads it — a native
 * import for `.js`/`.mjs`, otherwise through the project's Vite module
 * runner.
 */
export const readConfigSettings = Effect.fn("Astro.readConfigSettings")(function* (
  options: ReadConfigOutputOptions = {},
) {
  const root = yield* Effect.sync(() =>
    NodePath.resolve(options.cwd ?? process.cwd(), options.rootDir ?? "."),
  );
  const configPath = yield* Effect.sync(() =>
    options.config !== undefined
      ? NodePath.resolve(root, options.config)
      : CONFIG_FILES.map((file) => NodePath.join(root, file)).find((file) => existsSync(file)),
  );
  if (configPath === undefined) {
    return { output: undefined, workerCache: false } satisfies AstroConfigSettings;
  }
  const fail = (cause: unknown) =>
    new FrameworkError({
      framework: "astro",
      message: `Failed to load the Astro config at "${configPath}"`,
      cause,
    });
  const viaVite = resolveProjectPackageDirectory(root, "astro").pipe(
    Effect.flatMap((astroDirectory) => loadProjectModule<ViteModule>(astroDirectory, "vite")),
    Effect.mapError(fail),
    Effect.flatMap((vite) =>
      Effect.tryPromise({
        try: () =>
          vite.loadConfigFromFile(
            { command: "build", mode: "production" },
            configPath,
            root,
            "silent",
            undefined,
            "runner",
          ),
        catch: fail,
      }),
    ),
    Effect.map((loaded) => loaded?.config),
  );
  // Astro imports a JavaScript config natively (cache-busted, so an edited
  // config is re-read) and falls back to Vite when that fails.
  const config = /\.m?js$/.test(configPath)
    ? yield* Effect.tryPromise({
        try: async () =>
          (
            (await import(
              /* @vite-ignore */ `${pathToFileURL(configPath).href}?t=${Date.now()}`
            )) as { default?: unknown }
          ).default,
        catch: fail,
      }).pipe(Effect.catch(() => viaVite))
    : yield* viaVite;
  const output =
    typeof config === "object" && config !== null && "output" in config ? config.output : undefined;
  return {
    output: output === "server" || output === "static" ? (output as AstroOutput) : undefined,
    workerCache: usesCloudflareCacheProvider(config),
  } satisfies AstroConfigSettings;
});

/**
 * Read the `output` declared by a project's `astro.config.*` file, or
 * `undefined` when there is no config file or it does not set `output`.
 * See {@link readConfigSettings}.
 */
export const readConfigOutput = Effect.fn("Astro.readConfigOutput")(function* (
  options: ReadConfigOutputOptions = {},
) {
  return (yield* readConfigSettings(options)).output;
});
