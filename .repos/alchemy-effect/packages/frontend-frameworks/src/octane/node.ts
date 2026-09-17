/**
 * `@alchemy.run/frontend-frameworks/octane/node` — the Node container deploy
 * target for the Octane integration.
 *
 * Octane's Node story is its default (adapter-less) node server build:
 * with the marker adapter from
 * `@alchemy.run/frontend-frameworks/octane/node-adapter` selected in
 * `octane.config.ts` (`adapter: node()`, `serverTarget: "node"`), the
 * project's own `vite build` emits `dist/server/entry.js` — a
 * self-contained Node ESM bundle exporting a web-standard fetch `handler`.
 * The finishing pass writes a Node HTTP program that serves
 * `clientDirectory` first, then falls through to that handler on `PORT`
 * (default 3000), and answers `GET /health`. It re-reads `dist/server`
 * so runtime inputs — notably the SSR `index.html` the entry reads via
 * `join(__dirname, "./index.html")` — stay in the output. Container
 * FrameworkSites extraFile that template to dest `"index.html"` next to
 * the bundled `index.mjs` (not into `dist/`, or NodeServe would serve
 * the unrendered shell at `GET /`). The finish pass also disables
 * Octane's `isMainModule` auto-listen so rolldown flattening `entry.js`
 * into `index.mjs` cannot bind `PORT` before the generated serve entry.
 *
 * - **`adapterName` / `adapterPackage`** — the project's `octane.config.ts`
 *   must select `adapter: node()` from
 *   `@alchemy.run/frontend-frameworks/octane/node-adapter`.
 * - **`serverEntryFileName`** — `entry.js`, Octane's emitted node entry.
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
  readServerModulesFromDisk,
  sortServerModules,
} from "../core/index.ts";
import { make, type OctaneTarget, type OctaneTargetConfig } from "./Octane.ts";

/** The `adapter.name` the Node marker adapter declares. */
export const ADAPTER_NAME = "node";

/** The module providing the Node marker adapter for `octane.config.ts`. */
export const ADAPTER_PACKAGE =
  "@alchemy.run/frontend-frameworks/octane/node-adapter";

/** Octane's emitted node server entry within the server output directory. */
export const SERVER_ENTRY_FILE_NAME = "entry.js";

export interface OctaneNodeTargetConfig extends OctaneTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * Octane's node `entry.js` auto-listens when `import.meta.url` is the
 * process entry. Container hosts rolldown that file into `index.mjs`,
 * which would start a second HTTP server on `PORT` (EADDRINUSE) and
 * crash. Replace the guard with `false` so only the generated serve
 * entry binds the port.
 */
const neutralizeAutoListen = (source: string): string =>
  source
    .replaceAll(
      "fileURLToPath(import.meta.url) === resolve(process.argv[1])",
      "false",
    )
    .replaceAll(
      "fileURLToPath(import.meta.url)===resolve(process.argv[1])",
      "false",
    );

const makeNodeAdapterTarget = (
  config: OctaneNodeTargetConfig = {},
): OctaneTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    adapterName: ADAPTER_NAME,
    adapterPackage: ADAPTER_PACKAGE,
    serverEntryFileName: SERVER_ENTRY_FILE_NAME,
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (context.entry === undefined) {
          return yield* Effect.fail(
            fail("The Octane build produced no on-disk server entry to finish"),
          );
        }
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The Octane build produced no client directory for the Node serve entry",
            ),
          );
        }
        const serverDir = path.dirname(context.entry);
        const entrySource = yield* fs
          .readFileString(context.entry)
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to read dist/server/entry.js", error),
            ),
          );
        const neutralized = neutralizeAutoListen(entrySource);
        if (neutralized !== entrySource) {
          yield* fs
            .writeFileString(context.entry, neutralized)
            .pipe(
              Effect.mapError((error) =>
                fail(
                  "Failed to disable Octane auto-listen in dist/server/entry.js",
                  error,
                ),
              ),
            );
        }
        yield* fs
          .writeFileString(
            path.join(serverDir, "package.json"),
            '{"type":"module"}\n',
          )
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to write dist/server/package.json", error),
            ),
          );
        const servePath = path.join(serverDir, NODE_SERVE_ENTRY_FILE_NAME);
        const serveModuleName = path
          .join("server", NODE_SERVE_ENTRY_FILE_NAME)
          .replaceAll("\\", "/");
        const withServe = yield* writeNodeServeEntry({
          output,
          servePath,
          serveModuleName,
          clientDirExpression: relativeClientDirExpression(
            servePath,
            output.clientDirectory,
          ),
          handler: {
            kind: "fetch",
            imports: `import { handler } from ${JSON.stringify(`./${SERVER_ENTRY_FILE_NAME}`)};`,
            expr: "handler",
          },
          platform: "node",
        });
        // Re-read so the SSR `index.html` the entry reads beside itself is
        // part of the output (same as the AWS finishing pass).
        const modules = yield* readServerModulesFromDisk({
          directory: serverDir,
          prefix: "server",
        }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
        return {
          ...withServe,
          serverModules: sortServerModules(modules, serveModuleName),
        };
      }),
  });

export interface OctaneNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: OctaneNodeTargetConfig;
}

export const buildInChild = (config: OctaneNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      target: makeNodeAdapterTarget(config.config),
      compatibilityDate: config.config.compatibilityDate,
      compatibilityFlags: config.config.compatibilityFlags,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeNodeTarget = (
  config: OctaneNodeTargetConfig = {},
): OctaneTarget => ({
  ...makeNodeAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "octane",
      config: {
        rootDir: context.root,
        config,
      } satisfies OctaneNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;
