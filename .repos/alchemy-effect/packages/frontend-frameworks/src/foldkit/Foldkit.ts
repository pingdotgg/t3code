import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { Plugin } from "vite";
import * as Core from "../core/index.ts";
import type { NodeServeHtmlHandling, NodeServeNotFoundHandling } from "../core/NodeServe.ts";
import { make as makeVite, type ViteBuildConfig } from "../vite/Vite.ts";

/** The completed-build contract exposed by @foldkit/vite-plugin >= 0.25.0. */
export const BuildMetadata = Schema.Struct({
  root: Schema.String,
  clientDirectory: Schema.String,
  serverDirectory: Schema.String,
  serverEntry: Schema.String,
  manifest: Schema.Struct({
    schemaVersion: Schema.Literals([1]),
    client: Schema.String,
    server: Schema.String,
    serverEntry: Schema.String,
    prerendered: Schema.Array(Schema.String),
  }),
});
export type BuildMetadata = typeof BuildMetadata.Type;

export interface FoldkitTargetConfig {
  /** Serializable overrides for the project's Vite configuration. */
  readonly vite?: ViteBuildConfig | undefined;
  /** AWS topology: browser-only, prerendered assets, or a server with assets. Omit for automatic detection. */
  readonly output?: "spa" | "static" | "server" | undefined;
  /** Override the default SPA fallback for browser-only builds. */
  readonly notFoundHandling?: NodeServeNotFoundHandling | undefined;
  /** Override static HTML routing. */
  readonly htmlHandling?: NodeServeHtmlHandling | undefined;
}
export interface FoldkitTarget extends Core.DeployTarget<FoldkitTargetConfig> {}
export type FoldkitTargetInput = Core.DeployTargetInput<FoldkitTarget, FoldkitTargetConfig>;
export interface FoldkitOptions extends FoldkitTargetConfig {
  /** Project directory. @default process.cwd() */
  readonly root?: string | undefined;
  /** Deployment target. @default "@alchemy.run/frontend-frameworks/foldkit/aws" */
  readonly target?: FoldkitTargetInput | undefined;
  /** Native Vite development server options. */
  readonly dev?: { readonly port?: number | undefined } | undefined;
}
export const DEFAULT_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit/aws";

interface ViteBuilder {
  readonly config: {
    readonly root: string;
    readonly base: string;
    readonly plugins: ReadonlyArray<Pick<Plugin, "name" | "api">>;
    readonly build: { readonly outDir: string };
  };
  readonly environments: Record<
    string,
    {
      readonly config: {
        readonly root: string;
        readonly base: string;
        readonly build: { readonly outDir: string };
      };
    }
  >;
  readonly buildApp: () => Promise<unknown>;
  readonly build: (environment: unknown) => Promise<unknown>;
}
interface ViteModule {
  readonly createBuilder: (config: Record<string, unknown>) => Promise<ViteBuilder>;
}
const fail = (message: string, cause?: unknown) =>
  new Core.FrameworkError({ framework: "foldkit", message, cause });

/** Capture the plugin API before building, but only read it after buildApp succeeds. */
export const metadataReader = (plugins: ViteBuilder["config"]["plugins"]) => {
  const plugin = plugins.find((plugin) => plugin.name === "foldkit:build");
  if (!plugin) return undefined;
  if (typeof plugin.api?.getBuildMetadata !== "function") {
    throw fail("Foldkit SSR requires @foldkit/vite-plugin >= 0.25.0 with getBuildMetadata().");
  }
  // oxlint-disable-next-line effecttsgo/schema-sync -- read inside Vite's build callback; a throw is caught by its tryPromise
  return () => Schema.decodeUnknownSync(BuildMetadata)(plugin.api.getBuildMetadata());
};

/** Package only deployment artifacts, including independently configured client/server directories. */
export const readFoldkitOutput = (
  root: string,
  clientDirectory: string,
  metadata?: BuildMetadata,
  output?: FoldkitTargetConfig["output"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (output === "spa" && metadata) {
      return yield* fail(
        'Foldkit produced a server build. Set output: "server" for SSR/hybrid or output: "static" for prerendered assets.',
      );
    }
    if (output === "server" && !metadata) {
      return yield* fail(
        'Foldkit produced no server handler. Enable ssr.build in vite.config.ts or omit output: "server".',
      );
    }
    if (output === "static" && metadata && metadata.manifest.prerendered.length === 0) {
      return yield* fail(
        'Static Foldkit output requires prerendered pages. Configure ssr.build.prerender or use output: "server".',
      );
    }
    // Packaging lives outside `.alchemy`, which Neon's packager refuses to
    // ship from, and like it is gitignored and excluded from build memos.
    const distDirectory = path.join(root, "node_modules", ".cache", "alchemy", "foldkit");
    const isWithin = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    for (const directory of [clientDirectory, ...(metadata ? [metadata.serverDirectory] : [])]) {
      if (isWithin(distDirectory, directory) || isWithin(directory, distDirectory)) {
        return yield* fail(
          "Foldkit output directories must not overlap node_modules/.cache/alchemy/foldkit, which is reserved for deployment packaging.",
        );
      }
    }
    if (
      metadata &&
      (!isWithin(metadata.serverDirectory, metadata.serverEntry) ||
        metadata.serverEntry === metadata.serverDirectory)
    ) {
      return yield* fail("Foldkit's server entry must be inside its server output directory.");
    }
    yield* fs.remove(distDirectory, { recursive: true, force: true });
    yield* fs.makeDirectory(distDirectory, { recursive: true });
    const client = path.join(distDirectory, "client");
    yield* fs.copy(clientDirectory, client);
    if (!metadata || output === "static") {
      return {
        output: {
          distDirectory,
          clientDirectory: client,
          serverModules: undefined,
          externalWorkspaces: new Set<string>(),
        } satisfies Core.BuildOutput,
        entry: undefined,
      };
    }
    const server = path.join(distDirectory, "server");
    yield* fs.copy(metadata.serverDirectory, server);
    const entryName = path
      .relative(metadata.serverDirectory, metadata.serverEntry)
      .replaceAll("\\", "/");
    const modules = yield* Core.readServerModulesFromDisk({
      directory: server,
      prefix: "server",
    });
    if (!modules.some((module) => module.name === `server/${entryName}`)) {
      return yield* fail("Foldkit's generated server entry is missing from the build output.");
    }
    return {
      output: {
        distDirectory,
        clientDirectory: client,
        serverModules: Core.sortServerModules(modules, `server/${entryName}`),
        externalWorkspaces: new Set<string>(),
      } satisfies Core.BuildOutput,
      entry: path.join(server, entryName),
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Core.FrameworkError
        ? cause
        : fail("Failed to collect Foldkit build output", cause),
    ),
  );

/** Build with the project's plugin and host its native development server. */
export const make: (
  options?: FoldkitOptions,
) => Effect.Effect<Core.Framework["Service"], never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (options: FoldkitOptions = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseRoot = options.root ?? process.cwd();
    const config: FoldkitTargetConfig = {
      vite: options.vite,
      output: options.output,
      notFoundHandling: options.notFoundHandling,
      htmlHandling: options.htmlHandling,
    };
    const native = yield* makeVite({
      root: baseRoot,
      vite: options.vite,
      dev: options.dev,
    });
    const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const build: Core.Framework["Service"]["build"] = Effect.fn(function* (buildOptions) {
      const root = path.resolve(buildOptions?.root ?? baseRoot);
      const target = yield* Core.resolveDeployTarget<FoldkitTarget, FoldkitTargetConfig>(
        root,
        options.target ?? DEFAULT_TARGET_SPECIFIER,
        config,
      ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
      const context = { root, framework: "foldkit", env: buildOptions?.env };
      if (target.build)
        return yield* provide(target.build(context)).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
        );
      const vite = yield* Core.loadProjectModule<ViteModule>(root, "vite").pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
      );
      const built = yield* Effect.tryPromise({
        try: async () => {
          const outDir = options.vite?.outDir;
          const outputPlugin: Plugin = {
            name: "alchemy:foldkit-output",
            enforce: "post",
            config: (config) =>
              config.environments?.ssr?.build?.ssr
                ? {
                    // Like TanStack Start, deploy a self-contained Node bundle.
                    ssr: { noExternal: true },
                    environments: {
                      ...(outDir !== undefined
                        ? {
                            client: {
                              build: { outDir: path.join(outDir, "client") },
                            },
                          }
                        : {}),
                      ssr: {
                        resolve: { noExternal: true },
                        ...(outDir !== undefined
                          ? { build: { outDir: path.join(outDir, "server") } }
                          : {}),
                      },
                    },
                  }
                : undefined,
          };
          const builder = await vite.createBuilder({
            root,
            logLevel: "warn",
            ...(options.vite?.configFile !== undefined
              ? { configFile: path.resolve(root, options.vite.configFile) }
              : {}),
            ...(options.vite?.base !== undefined ? { base: options.vite.base } : {}),
            ...(outDir !== undefined ? { build: { outDir } } : {}),
            plugins: [outputPlugin],
          });
          const read = metadataReader(builder.config.plugins);
          // Without Foldkit's SSR build plugin the app is client-only; the
          // default `buildApp` would also build the `ssr` environment, whose
          // only input is `index.html`.
          if (read) await builder.buildApp();
          else await builder.build(builder.environments.client);
          const metadata = read?.();
          const client = builder.environments.client?.config ?? builder.config;
          return {
            metadata,
            assetBasePath: decodeURIComponent(new URL(client.base, "http://localhost").pathname),
            client: metadata?.clientDirectory ?? path.resolve(client.root, client.build.outDir),
          };
        },
        catch: (cause) => fail("Failed to build Foldkit", cause),
      });
      const collected = yield* provide(
        readFoldkitOutput(root, built.client, built.metadata, options.output),
      );
      return yield* provide(
        Core.applyDeployTargetFinish(target, collected.output, {
          ...context,
          entry: collected.entry,
          assetBasePath: built.assetBasePath,
        }),
      ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
    });
    return Core.Framework.of({ build, dev: native.dev });
  });

export const layer = (
  options?: FoldkitOptions,
): Layer.Layer<Core.Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Core.Framework, make(options));
