/**
 * `@alchemy.run/frontend-frameworks/nuxt/node` — the Node container deploy
 * target for the Nuxt integration.
 *
 * Nuxt's Node story is nitro's `node` (node-listener) preset:
 * `.output/server` is a self-contained Node ESM bundle whose entry exports
 * a Node `(req, res)` `handler`, and `.output/public` holds the static
 * assets. The finishing pass writes a Node HTTP program that serves
 * `clientDirectory` first, then falls through to that handler on `PORT`
 * (default 3000), and answers `GET /health`.
 *
 * - **`nitroPreset`** — `"node"`, enforced as the last word on the
 *   resolved nitro config. A user `nitro.preset` mismatch fails the build.
 * - **`entry`** — surfaces `config.main` as the generic user-entry carriage.
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import { make, type NuxtTarget, type NuxtTargetConfig } from "./Nuxt.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "node";

/**
 * The importable specifier of nitro's node-listener runtime handler — the
 * module a USER entry re-exports to wrap the framework's handler.
 */
export const NITRO_HANDLER_SPECIFIER =
  "nitropack/presets/node/runtime/node-listener";

export interface NuxtNodeTargetConfig extends NuxtTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

const makeNodeAdapterTarget = (config: NuxtNodeTargetConfig = {}): NuxtTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    entry: config.main !== undefined ? { main: config.main } : undefined,
    nitroPreset: NITRO_PRESET,
    configureNitro: (_nitroConfig, _context) => {
      // The user entry (context.entry) is deliberately NOT wired here —
      // the framework package sets it on the nitro INSTANCE at `nitro:init`
      // (a config-level entry would leak into the prerenderer's Node-preset
      // clone). See the matching note in ./cloudflare.ts.
    },
    finish: (output) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        if (
          output.distDirectory === undefined ||
          output.clientDirectory === undefined
        ) {
          return yield* Effect.fail(
            fail(
              "The Nuxt build produced no .output directories for the Node serve entry",
            ),
          );
        }
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
            kind: "node",
            imports: `import { handler } from "./index.mjs";`,
            expr: "handler",
          },
          platform: "node",
        });
      }),
  });

export interface NuxtNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: NuxtNodeTargetConfig;
}

export const buildInChild = (config: NuxtNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeAdapterTarget(config.config),
      compatibilityDate: config.config.compatibilityDate,
      compatibilityFlags: config.config.compatibilityFlags,
      main: config.config.main,
      nuxt: config.config.nuxt,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeNodeTarget = (
  config: NuxtNodeTargetConfig = {},
): NuxtTarget => ({
  ...makeNodeAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "nuxt",
      config: {
        rootDir: context.root,
        config,
      } satisfies NuxtNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;
