/**
 * `@alchemy.run/frontend-frameworks/sveltekit/node` — the Node container
 * deploy target for `@alchemy.run/frontend-frameworks/sveltekit`.
 *
 * SvelteKit's Node story mirrors adapter-node: kit's server graph
 * (`.svelte-kit/output/server`) is Node-flavored ESM. The finishing pass
 * re-bundles that graph with rolldown into `dist/server`, then writes a
 * Node HTTP program that serves `clientDirectory` first, then falls
 * through to kit's `Server.respond` on `PORT` (default 3000), and answers
 * `GET /health`.
 *
 * - **`adapter(context)`** — an in-memory kit `Adapter` that writes client
 *   assets + prerendered pages and an unbundled fetch-handler entry.
 * - **`finish(output, context)`** — re-bundles the entry for Node, writes
 *   the HTTP serve entry, pins it as `serverModules[0]`.
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 */
import type { Builder } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { rolldown } from "rolldown";
import { runBuildChild } from "../core/BuildChild.ts";
import * as FrameworkCore from "../core/index.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import {
  make,
  type SvelteKitAdapter,
  type SvelteKitAdapterResult,
  type SvelteKitTarget,
  type SvelteKitTargetConfig,
} from "./SvelteKit.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

export interface SvelteKitNodeTargetConfig extends SvelteKitTargetConfig {}

/** The bundled fetch-handler module the finishing pass writes. */
export const SERVER_ENTRY_NAME = NodePath.join("server", "index.mjs");

const generateFetchEntry = (options: {
  readonly serverImport: string;
}): string =>
  /* js */ `
import { server } from ${JSON.stringify(options.serverImport)};

const initialized = server.init({ env: process.env });

export const handler = async (request) => {
  await initialized;
  return await server.respond(request, {
    getClientAddress: () =>
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1',
  });
};
`.trimStart();

export const makeNodeAdapter = (): SvelteKitAdapter => {
  const result: { current?: SvelteKitAdapterResult | undefined } = {};
  return {
    name: "@alchemy.run/frontend-frameworks/sveltekit/node",
    result,
    async adapt(builder: Builder) {
      const dest = builder.getBuildDirectory("node");
      const tmp = builder.getBuildDirectory("node-tmp");

      builder.rimraf(dest);
      builder.rimraf(tmp);
      builder.mkdirp(dest);
      builder.mkdirp(tmp);

      const assetsDest = dest + builder.config.paths.base;
      builder.mkdirp(assetsDest);
      builder.writeClient(assetsDest);
      builder.writePrerendered(assetsDest);

      // pre-built server instance: kit 3.0 no longer exposes the internal
      // SSR manifest (`generateManifest` throws), so `generateServerInstance`
      // writes `export const server = new Server(manifest)` straight to
      // disk itself instead of returning a manifest string to embed. The
      // Node serve entry checks the filesystem for static assets, so unlike
      // the Cloudflare worker shim there's no route manifest to build.
      builder.generateServerInstance(NodePath.join(tmp, "server.js"));

      const workerEntry = NodePath.join(tmp, "entry.js");
      NodeFs.writeFileSync(
        workerEntry,
        generateFetchEntry({
          serverImport: "./server.js",
        }),
      );
      if (
        typeof builder.hasServerInstrumentationFile === "function" &&
        builder.hasServerInstrumentationFile()
      ) {
        // kit 3.0 requires an explicit initializer module that populates
        // `$env/dynamic/private` before instrumentation runs; the default
        // (`process.env`) is correct for the Node runtime.
        const initializer = builder.createInstrumentationInitializer({
          outputDirectory: tmp,
        });
        builder.instrument({
          entrypoint: workerEntry,
          instrumentation: NodePath.join(
            builder.getServerDirectory(),
            "instrumentation.server.js",
          ),
          initializer,
        });
      }

      result.current = { dest, workerEntry };
    },
    dispose: async () => {},
  };
};

const makeNodeAdapterTarget = (
  config: SvelteKitNodeTargetConfig = {},
): SvelteKitTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    adapter: (_context) => makeNodeAdapter(),
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const entry = context.entry;
        if (entry === undefined) {
          return yield* Effect.fail(
            fail(
              "The SvelteKit build produced no on-disk server entry for the finishing pass " +
                "(context.entry is missing)",
            ),
          );
        }
        const root = context.root;
        const distDirectory =
          output.distDirectory ?? path.resolve(root, "dist");
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The SvelteKit build produced no client directory for the Node serve entry",
            ),
          );
        }
        // Container hosts package only distDirectory. Keep the assets beside
        // the server so the output remains runnable after it is relocated.
        const clientDirectory = path.join(distDirectory, "client");
        yield* fs
          .remove(clientDirectory, { recursive: true, force: true })
          .pipe(
            Effect.andThen(fs.copy(output.clientDirectory, clientDirectory)),
            Effect.mapError((error) =>
              fail("Failed to package the SvelteKit client assets", error),
            ),
          );
        const serverOutDir = path.join(distDirectory, "server");
        yield* fs
          .remove(serverOutDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to clean dist/server", error),
            ),
          );

        yield* Effect.tryPromise({
          try: async () => {
            const bundle = await rolldown({
              cwd: root,
              input: entry,
              platform: "node",
              resolve: {
                conditionNames: [...NODE_BUNDLE_CONDITIONS],
              },
              external: [/^node:/],
            });
            try {
              await bundle.write({
                dir: serverOutDir,
                format: "esm",
                entryFileNames: "index.mjs",
                chunkFileNames: "chunks/[name].mjs",
                sourcemap: false,
              });
            } finally {
              await bundle.close();
            }
          },
          catch: (error) => fail("Failed to bundle the Node server", error),
        });

        const modules = yield* FrameworkCore.readServerModulesFromDisk({
          directory: serverOutDir,
          prefix: "server",
        }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
        const bundled: FrameworkCore.BuildOutput = {
          ...output,
          distDirectory,
          clientDirectory,
          serverModules: FrameworkCore.sortServerModules(
            modules,
            SERVER_ENTRY_NAME,
          ),
        };
        const servePath = path.join(serverOutDir, NODE_SERVE_ENTRY_FILE_NAME);
        return yield* writeNodeServeEntry({
          output: bundled,
          servePath,
          serveModuleName: path
            .join("server", NODE_SERVE_ENTRY_FILE_NAME)
            .replaceAll("\\", "/"),
          clientDirExpression: relativeClientDirExpression(
            servePath,
            clientDirectory,
          ),
          htmlHandling: "drop-trailing-slash",
          handler: {
            kind: "fetch",
            imports: `import { handler } from "./index.mjs";`,
            expr: "handler",
          },
          notFoundHandling:
            config.adapter?.notFoundHandling === "single-page-application"
              ? "spa"
              : config.adapter?.notFoundHandling === "404-page"
                ? "404-page"
                : "none",
          platform: "node",
        });
      }),
  });

export interface SvelteKitNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: SvelteKitNodeTargetConfig;
}

export const buildInChild = (config: SvelteKitNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeAdapterTarget(config.config),
      compatibilityDate: config.config.compatibilityDate,
      compatibilityFlags:
        config.config.compatibilityFlags !== undefined
          ? [...config.config.compatibilityFlags]
          : undefined,
      kit: config.config.kit,
      adapter: config.config.adapter,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeNodeTarget = (
  config: SvelteKitNodeTargetConfig = {},
): SvelteKitTarget => ({
  ...makeNodeAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "sveltekit",
      config: {
        rootDir: context.root,
        config,
      } satisfies SvelteKitNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;
