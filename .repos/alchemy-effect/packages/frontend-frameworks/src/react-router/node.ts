/**
 * `@alchemy.run/frontend-frameworks/react-router/node` — the Node container
 * deploy target for the React Router v7 integration.
 *
 * React Router builds through Vite: `reactRouter()` in the project's
 * `vite.config.ts` builds a `client` environment into
 * `<buildDirectory>/client` and a server environment into
 * `<buildDirectory>/server`. Its server output is a `ServerBuild` MANIFEST
 * with no default export, so the framework half makes the server build's
 * rollup input a wrapper that turns the manifest into a fetch handler with
 * `createRequestHandler` from `react-router` (see `serverEntrySource` in
 * `ReactRouter.ts`). What this target owns is the Node packaging on top of
 * that fetch handler:
 *
 * - **`serverEntryFileName`** — `index.js`, the chunk the server pass emits
 *   (React Router's `serverBuildFile`); the finishing pass wraps it.
 * - **`finish`** — emits the Node deployment surface next to the entry: a
 *   `package.json` (`type: "module"` so Node classifies the `.js` server
 *   build as ESM) and a Node HTTP program (`serve-node.mjs`) that serves
 *   `clientDirectory` first, then falls through to that fetch handler on
 *   `PORT` (default 3000), and answers `GET /health`.
 * - **`bundle`** — Node resolve conditions (no `workerd`, no `@aws-sdk/`).
 *
 * No Lambda adapter: the serve entry talks to the fetch handler directly.
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
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  DEFAULT_SERVER_BUILD_FILE,
  make,
  type ReactRouterTarget,
  type ReactRouterTargetConfig,
} from "./ReactRouter.ts";

/** The server entry file name React Router's server pass emits. */
export const SERVER_ENTRY_FILE_NAME = DEFAULT_SERVER_BUILD_FILE;

/** Node-specific knobs carried on the shared {@link ReactRouterTargetConfig}. */
export interface ReactRouterNodeTargetConfig extends ReactRouterTargetConfig {}

/** The Node {@link ReactRouterTarget}, carrying the Node-specific config. */
export interface ReactRouterNodeTarget extends ReactRouterTarget {
  readonly config: ReactRouterNodeTargetConfig;
}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * Import the server build's fetch handler. The entry module default-exports
 * `{ fetch }` (the shape the integration's virtual server entry produces). A
 * project whose own entry default-exports the bare fetch function is
 * accepted too.
 */
const fetchHandlerImports = (serverEntryFileName: string): string =>
  `import * as serverEntry from ${JSON.stringify(`./${serverEntryFileName}`)};

const entry = serverEntry.default ?? serverEntry;
const fetchHandler =
  typeof entry === "function"
    ? entry
    : (request) => entry.fetch(request);`;

const makeNodeFinishTarget = (
  config: ReactRouterNodeTargetConfig = {},
): ReactRouterNodeTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    serverEntryFileName: SERVER_ENTRY_FILE_NAME,
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (context.entry === undefined) {
          return yield* Effect.fail(
            fail(
              "The React Router build produced no on-disk server entry to finish",
            ),
          );
        }
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The React Router build produced no client directory for the Node serve entry",
            ),
          );
        }
        const serverDir = path.dirname(context.entry);
        const serverEntryFileName = path.basename(context.entry);
        yield* fs
          .writeFileString(
            path.join(serverDir, "package.json"),
            '{"type":"module"}\n',
          )
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to write the server package.json", error),
            ),
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
            imports: fetchHandlerImports(serverEntryFileName),
            expr: "fetchHandler",
          },
          platform: "node",
        });
      }),
  });

/**
 * A React Router build loads and executes the project's `vite.config.*` and
 * `react-router.config.ts` (user plugins may mutate `process.env` or
 * `process.chdir`, and React Router's config loader spins its own vite-node
 * server) — none of which may touch the engine process, where many deploys
 * share one event loop. This target's wholesale `build` therefore runs the
 * framework in a disposable child process whose working directory IS the
 * project root (see `core/BuildChild.ts`). The shared
 * `core/BuildChildRunner` entry imports this module in the child and calls
 * the exported {@link buildInChild}.
 */
export interface ReactRouterNodeBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: ReactRouterNodeTargetConfig;
}

export const buildInChild = (config: ReactRouterNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The finish-only target: no wholesale `build` hook, so the child
      // runs the regular vite build + finish pipeline (no recursion).
      target: makeNodeFinishTarget(config.config),
      buildDirectory: config.config.buildDirectory,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Node {@link ReactRouterTarget}. See the module doc for the
 * seams.
 */
export const makeNodeTarget = (
  config: ReactRouterNodeTargetConfig = {},
): ReactRouterNodeTarget => ({
  ...makeNodeFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "react-router",
      config: {
        rootDir: context.root,
        config,
      } satisfies ReactRouterNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeNodeTarget;

export default makeNodeTarget;
