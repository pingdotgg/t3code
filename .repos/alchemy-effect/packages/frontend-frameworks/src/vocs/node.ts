/**
 * `@alchemy.run/frontend-frameworks/vocs/node` — the Node container deploy
 * target for Vocs.
 *
 * Vocs is Waku-based RSC. The target runs the vocs build in a disposable
 * child process (cwd = project root) with waku's node adapter, then writes
 * a Node HTTP program that serves `clientDirectory` first (extensionless
 * HTML: `/about` → `about/index.html`) and falls through to
 * `INTERNAL_runFetch`. Vocs' default `renderStrategy` is `"dynamic"`, so
 * dropping server modules would deploy an empty html-shell (no pages).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import {
  DeployTargetError,
  Framework,
  makeDeployTarget,
  type Framework as FrameworkService,
} from "../core/index.ts";
import type { VocsTarget } from "./Target.ts";
import { make as makeVocsLayer } from "./Vocs.ts";

export interface VocsNodeTargetConfig {}

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/**
 * The in-child target: adapter + empty vite plugins, no wholesale `build`
 * (the child runs the regular vocs pipeline). `finish` writes the Node
 * serve entry so dynamic pages SSR instead of serving the empty html-shell.
 */
const makeNodeAdapterTarget = (
  config: VocsNodeTargetConfig = {},
): VocsTarget<VocsNodeTargetConfig> =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
    adapter: (context) =>
      Effect.succeed(
        NodePath.join(context.wakuDirectory, "dist/adapters/node.js"),
      ),
    vitePlugins: () => Effect.sync(() => []),
    finish: (output) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (output.distDirectory === undefined) {
          return yield* Effect.fail(
            fail("The vocs build produced no dist directory"),
          );
        }
        if (output.clientDirectory === undefined) {
          return yield* Effect.fail(
            fail(
              "The vocs build produced no client directory for the Node serve entry",
            ),
          );
        }
        const serverDir = path.join(output.distDirectory, "server");
        const serverIndex = path.join(serverDir, "index.js");
        const hasServerIndex = yield* fs
          .exists(serverIndex)
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to probe the built server entry", error),
            ),
          );
        if (!hasServerIndex) {
          return yield* Effect.fail(
            fail(`The vocs build produced no server entry at ${serverIndex}`),
          );
        }
        yield* fs
          .writeFileString(
            path.join(serverDir, "package.json"),
            `${JSON.stringify({ type: "module" }, null, 2)}\n`,
          )
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to write dist/server/package.json", error),
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
            imports: `import { INTERNAL_runFetch } from "./index.js";`,
            expr: "(req, ...args) => INTERNAL_runFetch(process.env, req, ...args)",
          },
          htmlHandling: "drop-trailing-slash",
          platform: "node",
        });
      }),
  });

export interface VocsNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: VocsNodeTargetConfig;
}

export const buildInChild = (config: VocsNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* Framework.pipe(
      Effect.provide(
        makeVocsLayer({
          root: config.rootDir,
          target: makeNodeAdapterTarget(config.config),
        }),
      ),
    );
    return yield* framework.build({ root: config.rootDir });
  });

/**
 * Create the Node {@link VocsTarget}: the wholesale `build` hook runs
 * the vocs pipeline in a child process (cwd = project root).
 */
export const makeNodeTarget = (
  config: VocsNodeTargetConfig = {},
): VocsTarget<VocsNodeTargetConfig> => ({
  ...makeNodeAdapterTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "vocs",
      config: {
        rootDir: context.root,
        config,
      } satisfies VocsNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;

export interface VocsNodeFrameworkOptions {
  readonly root?: string | undefined;
  readonly target?: string | undefined;
  readonly outDir?: string | undefined;
}

/**
 * Framework-module contract used by container Website composites
 * (`module.make(...)` returns `{ build, dev }`, not a Layer).
 */
export const make = (options: VocsNodeFrameworkOptions = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolveRoot = (override: string | undefined) =>
      path.resolve(override ?? options.root ?? process.cwd());

    const withFramework = <A, E, R>(
      root: string,
      use: (framework: FrameworkService["Service"]) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const framework = yield* Framework.pipe(
          Effect.provide(
            makeVocsLayer({
              root,
              // Parent path: child-process target so Vocs Config.resolve()
              // and group-icons glob src/pages with cwd = project root.
              target: makeNodeTarget({}),
            }),
          ),
        );
        return yield* use(framework);
      });

    return {
      build: (buildOptions?: { readonly root?: string }) => {
        const root = resolveRoot(buildOptions?.root);
        return withFramework(root, (framework) => framework.build({ root }));
      },
      dev: (devOptions?: {
        readonly root?: string;
        readonly port?: number;
        readonly host?: string;
      }) => {
        const root = resolveRoot(devOptions?.root);
        return withFramework(root, (framework) =>
          framework.dev({
            root,
            port: devOptions?.port,
            host: devOptions?.host,
          }),
        );
      },
    };
  });
