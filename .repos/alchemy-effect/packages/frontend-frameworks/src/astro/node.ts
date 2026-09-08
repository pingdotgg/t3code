/**
 * `@alchemy.run/frontend-frameworks/astro/node` — the Node container deploy
 * target for the Astro integration.
 *
 * Astro's Node story is a plain Node SSR bundle behind a long-running HTTP
 * server: the adapter integration pins this package's `node-server`
 * entrypoint (which exports `App.render` as a fetch handler) as the build's
 * server entry, and forces the server build to be **self-contained**
 * (`vite.ssr.noExternal: true`). The finishing pass writes a Node HTTP
 * program that serves `clientDirectory` first, then falls through to that
 * handler on `PORT` (default 3000), and answers `GET /health`.
 *
 * - **`integration`** — the adapter integration: registers itself via
 *   `setAdapter` at `astro:config:done` (rejecting a user-declared adapter
 *   with an actionable error) and pins the `node-server` entrypoint.
 * - **`finish`** — a fully-static build (`output: "static"`) writes the
 *   same Node static serve entry Vite uses. Otherwise writes the HTTP
 *   serve entry (static files then the Astro fetch handler) and pins it
 *   as `serverModules[0]`.
 * - **`selectServerEntry`** — pins the adapter's entry chunk as
 *   `serverModules[0]` before the finishing pass wraps it.
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 */
import type { AstroInlineConfig, AstroIntegration } from "astro";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import {
  DeployTargetError,
  makeDeployTarget,
  type ServerEntryChunk,
} from "../core/index.ts";
import { make } from "./Astro.ts";
import type { AstroTarget, AstroTargetBuildContext } from "./Target.ts";

/**
 * The importable specifier of this package's Node server entrypoint — the
 * module the adapter pins as `serverEntrypoint`. It exports a fetch
 * `handler`.
 */
export const SERVER_ENTRYPOINT =
  "@alchemy.run/frontend-frameworks/astro/entrypoints/node-server";

/** Node-specific target configuration. */
export interface AstroNodeConfig {}

export interface AstroNodeTarget extends AstroTarget<AstroNodeConfig> {}

/** Options for {@link distilledNode} (the adapter integration). */
export interface DistilledNodeOptions {
  /**
   * Reports the resolved build output mode (`astro:config:done`'s
   * `buildOutput`): `"static"` when every route is prerendered, `"server"`
   * when any route renders on demand. The target's `finish` pass uses it to
   * strip `serverModules` from a fully-static build so the deploy is
   * assets-only.
   * @internal
   */
  readonly onBuildOutput?:
    | ((buildOutput: "static" | "server") => void)
    | undefined;
  /**
   * Reports the resolved server-entry file name (`config.build.serverEntry`,
   * `entry.mjs` by default) so the entry chunk can be pinned as
   * `serverModules[0]` before the serve wrap.
   * @internal
   */
  readonly onServerEntryName?: ((name: string) => void) | undefined;
}

/**
 * The Node adapter integration for Astro. Injected via `integrations`
 * (after the user's) rather than `adapter`: it registers itself as the
 * adapter at `astro:config:done`, where it also rejects a user-declared
 * adapter with an actionable error.
 */
export const distilledNode = (
  options: DistilledNodeOptions = {},
): AstroIntegration => {
  let injectedAdapterMarker = false;
  return {
    name: "@alchemy.run/frontend-frameworks/astro-node",
    hooks: {
      "astro:config:setup": ({ config, updateConfig }) => {
        if (config.adapter === undefined) {
          injectedAdapterMarker = true;
          updateConfig({
            adapter: {
              name: "@alchemy.run/frontend-frameworks/astro-node",
              hooks: {},
            },
          });
        }
      },
      "astro:config:done": ({ setAdapter, config, buildOutput }) => {
        if (config.adapter !== undefined && !injectedAdapterMarker) {
          throw new Error(
            `@alchemy.run/frontend-frameworks/astro/node: the Astro config declares the adapter "${config.adapter.name}", ` +
              "but the deploy target already provides the Node adapter. " +
              "Remove `adapter` from your astro.config file — user integrations " +
              "(react, mdx, tailwind, ...) are honored, and the adapter is injected by the toolchain.",
          );
        }
        options.onBuildOutput?.(buildOutput);
        options.onServerEntryName?.(config.build.serverEntry);
        setAdapter({
          name: "@alchemy.run/frontend-frameworks/astro-node",
          entrypointResolution: "auto",
          serverEntrypoint: SERVER_ENTRYPOINT,
          adapterFeatures: {
            buildOutput,
            middlewareMode: "classic",
            preserveBuildClientDir: true,
            preserveBuildServerDir: true,
          },
          supportedAstroFeatures: {
            serverOutput: "stable",
            hybridOutput: "stable",
            staticOutput: "stable",
            i18nDomains: "experimental",
            envGetSecret: "stable",
            sharpImageService: {
              support: "limited",
              message:
                "sharp is not shipped with the Node server bundle; install it as a project dependency to optimize images at build time",
            },
          },
        });
      },
      "astro:build:setup": ({ vite: viteConfig, target }) => {
        if (target === "server") {
          viteConfig.ssr ||= {};
          viteConfig.ssr.noExternal = true;
        }
      },
    },
  };
};

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

const makeNodeAdapterTarget = (
  config: AstroNodeConfig = {},
): AstroNodeTarget => {
  let buildOutput: "static" | "server" | undefined;
  let serverEntryName: string | undefined;
  return makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    integration: () =>
      distilledNode({
        onBuildOutput: (mode) => {
          buildOutput = mode;
        },
        onServerEntryName: (name) => {
          serverEntryName = name;
        },
      }),
    selectServerEntry: (chunk: ServerEntryChunk): boolean =>
      chunk.fileName === (serverEntryName ?? "entry.mjs") ||
      (chunk.facadeModuleId !== null &&
        /\/entrypoints\/node-server\.(?:ts|js|mjs)$/.test(
          chunk.facadeModuleId.replaceAll("\\", "/"),
        )),
    finish: (output) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        if (buildOutput === "static") {
          if (output.clientDirectory === undefined) {
            return yield* Effect.fail(
              fail(
                "The Astro static build produced no client directory for the Node serve entry",
              ),
            );
          }
          const servePath = path.join(
            output.clientDirectory,
            NODE_SERVE_ENTRY_FILE_NAME,
          );
          return yield* writeNodeServeEntry({
            output,
            servePath,
            serveModuleName: NODE_SERVE_ENTRY_FILE_NAME,
            clientDirExpression: `fileURLToPath(new URL("./", import.meta.url))`,
            notFoundHandling: "spa",
            platform: "node",
          });
        }
        if (
          output.distDirectory === undefined ||
          output.clientDirectory === undefined
        ) {
          return yield* Effect.fail(
            fail(
              "The Astro build produced no dist/client directories for the Node serve entry",
            ),
          );
        }
        const entryName = serverEntryName ?? "entry.mjs";
        const servePath = path.join(
          output.distDirectory,
          "server",
          NODE_SERVE_ENTRY_FILE_NAME,
        );
        return yield* writeNodeServeEntry({
          output,
          servePath,
          serveModuleName: path
            .join("server", NODE_SERVE_ENTRY_FILE_NAME)
            .replaceAll("\\", "/"),
          clientDirExpression: relativeClientDirExpression(
            servePath,
            output.clientDirectory,
          ),
          handler: {
            kind: "fetch",
            imports: `import { handler } from ${JSON.stringify(`./${entryName}`)};`,
            expr: "handler",
          },
          platform: "node",
        });
      }),
  });
};

export interface AstroNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: AstroNodeConfig;
  readonly astro: AstroInlineConfig | undefined;
}

export const buildInChild = (config: AstroNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeAdapterTarget(config.config),
      astro: config.astro,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Build the Node {@link AstroTarget}. See the module doc for the seams.
 */
export const makeNodeTarget = (
  config: AstroNodeConfig = {},
): AstroNodeTarget => ({
  ...makeNodeAdapterTarget(config),
  build: (context: AstroTargetBuildContext) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "astro",
      config: {
        rootDir: context.root,
        config,
        astro: context.astro,
      } satisfies AstroNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;
