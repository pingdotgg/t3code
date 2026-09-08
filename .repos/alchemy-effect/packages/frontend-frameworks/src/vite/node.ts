/**
 * `@alchemy.run/frontend-frameworks/vite/node` — the Node container deploy
 * target for the plain Vite integration.
 *
 * A plain Vite build is assets-only (client bundle + `index.html`). The
 * finishing pass writes a Node HTTP program (`serve-node.mjs`) into
 * `clientDirectory` that serves those files, answers `GET /health`, and
 * applies SPA / 404-page fallback. Platform composites deploy that file
 * as-is (`isExternal`) — they do not generate a second static server.
 *
 * The wholesale `build` hook runs the project's `vite build` in a
 * disposable child process whose working directory IS the project root
 * (see `core/BuildChild.ts`).
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import { make, type ViteTarget, type ViteTargetConfig } from "./Vite.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * The in-child target: no wholesale `build` hook, so the child runs the
 * regular vite-build pipeline (no recursion) then this finish.
 */
const makeNodeChildTarget = (config: ViteTargetConfig = {}): ViteTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    finish: (output) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The Vite build produced no client directory for the Node serve entry",
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
          notFoundHandling: config.notFoundHandling ?? "spa",
          htmlHandling: config.htmlHandling ?? "none",
          platform: "node",
        });
      }),
  });

/** The runner's JSON payload for the build child (see `core/BuildChild.ts`). */
export interface ViteNodeBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: ViteTargetConfig;
}

/** The pure in-child build entry the shared `BuildChildRunner` invokes. */
export const buildInChild = (config: ViteNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeChildTarget(config.config),
      vite: config.config.vite,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Node {@link ViteTarget}: the assets-only target whose `build`
 * spawns the vite build in a child process.
 */
export const makeNodeTarget = (config: ViteTargetConfig = {}): ViteTarget => ({
  ...makeNodeChildTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "vite",
      config: {
        rootDir: context.root,
        config,
      } satisfies ViteNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeNodeTarget;

export default makeNodeTarget;
