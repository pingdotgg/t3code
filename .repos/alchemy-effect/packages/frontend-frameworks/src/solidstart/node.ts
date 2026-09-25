/**
 * `@alchemy.run/frontend-frameworks/solidstart/node` — the Node container
 * deploy target for the SolidStart integration.
 *
 * SolidStart's Node story is nitro's `node` (node-listener) preset:
 * `.output/server` is a self-contained Node ESM bundle whose entry exports
 * a Node `(req, res)` `handler`, and `.output/public` holds the static
 * assets. The finishing pass writes a Node HTTP program that serves
 * `clientDirectory` first, then falls through to that handler on `PORT`
 * (default 3000), and answers `GET /health`.
 *
 * - **`nitroPreset`** — `"node"`, enforced as the last word on the
 *   resolved nitro config. A user `nitro.preset` mismatch fails the build.
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 *
 * Do not use the `aws-lambda` preset: that emits a Lambda `handler`, not a
 * Node listener.
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
import {
  make,
  type SolidStartTarget,
  type SolidStartTargetConfig,
} from "./SolidStart.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "node";

/**
 * The importable specifier of nitro's node-listener runtime handler — the
 * module a USER entry re-exports to wrap the framework's handler.
 */
export const NITRO_HANDLER_SPECIFIER =
  "nitropack/presets/node/runtime/node-listener";

export interface SolidStartNodeTargetConfig extends SolidStartTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

const makeNodeAdapterTarget = (
  config: SolidStartNodeTargetConfig = {},
): SolidStartTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    nitroPreset: NITRO_PRESET,
    finish: (output) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        if (
          output.distDirectory === undefined ||
          output.clientDirectory === undefined
        ) {
          return yield* Effect.fail(
            fail(
              "The SolidStart build produced no .output directories for the Node serve entry",
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

export interface SolidStartNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: SolidStartNodeTargetConfig;
}

export const buildInChild = (config: SolidStartNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeAdapterTarget(config.config),
      nitro: config.config.nitro,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeNodeTarget = (
  config: SolidStartNodeTargetConfig = {},
): SolidStartTarget => ({
  ...makeNodeAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "solidstart",
      config: {
        rootDir: context.root,
        config,
      } satisfies SolidStartNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;
