/**
 * `@alchemy.run/frontend-frameworks/waku/node` — the Node container deploy
 * target for the Waku integration.
 *
 * Waku's Node story is a plain-Node waku build with waku's own `node`
 * adapter selected via `unstable_adapter`. The finishing pass writes a
 * Node HTTP program that serves `clientDirectory` first (extensionless
 * HTML: `/about` → `about/index.html`), then falls through to
 * `INTERNAL_runFetch` on `PORT` (default 3000), and answers `GET /health`.
 *
 * - **`adapter`** — the project's `waku/adapters/node`.
 * - **`vitePlugins`** — none (plain Node; no workerd plugin).
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
import type { Config as WakuConfig } from "waku/config";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import { make, type WakuTarget, type WakuTargetBuildContext } from "./Waku.ts";

export type { WakuTarget, WakuTargetContext } from "./Waku.ts";

export interface WakuNodeTargetConfig {
  readonly main?: string | undefined;
}

const fail = (message: string) => (cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

const makeNodeAdapterTarget = (
  config?: WakuNodeTargetConfig,
): WakuTarget<WakuNodeTargetConfig | undefined> =>
  makeDeployTarget({
    platform: "node",
    config,
    entry: config?.main !== undefined ? { main: config.main } : undefined,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    adapter: (context) =>
      Effect.succeed(
        NodePath.join(context.wakuDirectory, "dist/adapters/node.js"),
      ),
    vitePlugins: () => Effect.sync(() => []),
    finish: (output, _context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (output.distDirectory === undefined) {
          return yield* Effect.fail(
            fail("The waku build produced no dist directory")(undefined),
          );
        }
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The waku build produced no client directory for the Node serve entry",
            )(undefined),
          );
        }
        const serverDir = path.join(output.distDirectory, "server");
        const serverIndex = path.join(serverDir, "index.js");
        const hasServerIndex = yield* fs
          .exists(serverIndex)
          .pipe(
            Effect.mapError(fail("Failed to probe the built server entry")),
          );
        if (!hasServerIndex) {
          return yield* Effect.fail(
            fail(`The waku build produced no server entry at ${serverIndex}`)(
              undefined,
            ),
          );
        }
        yield* fs
          .writeFileString(
            path.join(serverDir, "package.json"),
            `${JSON.stringify({ type: "module" }, null, 2)}\n`,
          )
          .pipe(
            Effect.mapError(fail("Failed to write dist/server/package.json")),
          );
        const servePath = path.join(serverDir, NODE_SERVE_ENTRY_FILE_NAME);
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
            imports: `import { INTERNAL_runFetch } from "./index.js";`,
            expr: "(req, ...args) => INTERNAL_runFetch(process.env, req, ...args)",
          },
          htmlHandling: "drop-trailing-slash",
          platform: "node",
        });
      }),
  });

export interface WakuNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: WakuNodeTargetConfig | undefined;
  readonly waku: WakuConfig | undefined;
}

export const buildInChild = (config: WakuNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeAdapterTarget(config.config),
      waku: config.waku,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeNodeTarget = (
  config?: WakuNodeTargetConfig,
): WakuTarget<WakuNodeTargetConfig | undefined> => ({
  ...makeNodeAdapterTarget(config),
  build: (context: WakuTargetBuildContext) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "waku",
      config: {
        rootDir: context.root,
        config,
        waku: context.waku,
      } satisfies WakuNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message)(error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;
