/**
 * `@alchemy.run/frontend-frameworks/tanstack-start/node` — the Node
 * container deploy target for the TanStack Start integration.
 *
 * TanStack Start is pure Vite: `tanstackStart()` in the project's
 * `vite.config.ts` builds a `client` environment into `<outDir>/client` and
 * an `ssr` environment into `<outDir>/server`, whose entry module
 * default-exports `{ fetch }` — a web-standard fetch handler. There is no
 * adapter to select and no deployment preset; what this target owns is the
 * Node packaging:
 *
 * - **`serverEntryFileName`** — `server.js`, the chunk the SSR environment
 *   emits for the resolved server entry; the finishing pass wraps it.
 * - **`finish`** — emits the Node deployment surface next to the entry: a
 *   `package.json` (`type: "module"` so Node classifies the `.js` SSR
 *   bundle as ESM) and a Node HTTP program (`serve-node.mjs`) that serves
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
  DEFAULT_SERVER_ENTRY_FILE_NAME,
  make,
  type TanStackStartTarget,
  type TanStackStartTargetConfig,
} from "./TanStackStart.ts";

/** The server entry file name the SSR environment emits. */
export const SERVER_ENTRY_FILE_NAME = DEFAULT_SERVER_ENTRY_FILE_NAME;

/** Node-specific knobs carried on the shared {@link TanStackStartTargetConfig}. */
export interface TanStackStartNodeTargetConfig extends TanStackStartTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * Import TanStack Start's server entry fetch handler. The entry module
 * default-exports `{ fetch }` (the shape `createServerEntry` produces). A
 * project whose custom server entry default-exports the bare fetch function
 * is accepted too.
 */
const fetchHandlerImports = (serverEntryFileName: string): string =>
  `import * as serverEntry from ${JSON.stringify(`./${serverEntryFileName}`)};

const entry = serverEntry.default ?? serverEntry;
const fetchHandler =
  typeof entry === "function"
    ? entry
    : (request) => entry.fetch(request);`;

/**
 * The finish-only target — the shape the framework's regular build/finish
 * pipeline consumes. Used directly in the build child (where `cwd === root`
 * holds); {@link makeNodeTarget} wraps it with the wholesale `build` hook
 * that spawns the child.
 */
const makeNodeFinishTarget = (
  config: TanStackStartNodeTargetConfig = {},
): TanStackStartTarget =>
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
              "The TanStack Start build produced no on-disk server entry to finish",
            ),
          );
        }
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The TanStack Start build produced no client directory for the Node serve entry",
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
 * A TanStack Start build loads and executes the project's `vite.config.*`
 * (its `tanstackStart()` plugin crawls framework packages from
 * `process.cwd()`, and user plugins may mutate `process.env` or
 * `process.chdir`) — none of which may touch the engine process, where many
 * deploys share one event loop. This target's wholesale `build` therefore
 * runs the framework in a disposable child process whose working directory
 * IS the project root (see `core/BuildChild.ts`). The shared
 * `core/BuildChildRunner` entry imports this module in the child and calls
 * the exported {@link buildInChild}.
 */
export interface TanStackStartNodeBuildChildConfig {
  readonly rootDir: string;
  /** The (JSON-serializable) target config the parent was created with. */
  readonly config: TanStackStartNodeTargetConfig;
}

export const buildInChild = (config: TanStackStartNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* make({
      root: config.rootDir,
      // The finish-only target: no wholesale `build` hook, so the child
      // runs the regular vite build + finish pipeline (no recursion).
      target: makeNodeFinishTarget(config.config),
      outDir: config.config.outDir,
    });
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Node {@link TanStackStartTarget}. See the module doc for the
 * seams.
 */
export const makeNodeTarget = (
  config: TanStackStartNodeTargetConfig = {},
): TanStackStartTarget => ({
  ...makeNodeFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "tanstack-start",
      config: {
        rootDir: context.root,
        config,
      } satisfies TanStackStartNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeNodeTarget;

export default makeNodeTarget;
