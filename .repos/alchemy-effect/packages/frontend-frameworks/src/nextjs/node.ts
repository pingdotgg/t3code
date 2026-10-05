/**
 * `@alchemy.run/frontend-frameworks/nextjs/node` — Next.js on a Node
 * container (`next build` + a custom `next({ dev: false })` server).
 *
 * Unlike the Cloudflare (`./index.ts`, OpenNext CF) and AWS (`./aws.ts`,
 * OpenNext AWS) integrations, this module does **not** use OpenNext. The
 * container-optimal path is a long-running Node process:
 *
 * - **`build`** runs the project's `next build` in a disposable child
 *   (cwd = project root), then writes the shared Node serve entry
 *   (`GET /health`, listens on `PORT`, default 3000) around
 *   {@link NEXT_PRODUCTION_APP_SOURCE}: `next({ dev: false }).prepare()`
 *   over the resolved build config + `getRequestHandler()`.
 * - **`dev`** runs the real `next dev` CLI (plain Node), scoped.
 *
 * Composites should load this module as the framework specifier (same
 * shape as `./aws`) or pass `target:
 * "@alchemy.run/frontend-frameworks/nextjs/node"`.
 */
import * as FrameworkCore from "../core/index.ts";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { createRequire } from "node:module";
import type * as NodeChildProcessModule from "node:child_process";
import type * as NodeNet from "node:net";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  writeNodeServeEntry,
  type NodeServeHandler,
} from "../core/NodeServe.ts";
import {
  DeployTargetError,
  makeDeployTarget,
  type DeployTarget,
} from "../core/index.ts";

const failFramework = (message: string) => (cause: unknown) =>
  new FrameworkCore.FrameworkError({ framework: "nextjs", message, cause });

const failTarget = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

/** Options for the Next.js Node framework module / deploy target. */
export interface NextjsNodeOptions {
  readonly root?: string | undefined;
  /**
   * The deploy target module specifier the caller resolved this module as.
   * This module IS the Node target — accepted and ignored (parity with
   * `./aws`).
   */
  readonly target?: string | undefined;
}

export interface NextjsNodeTargetConfig {
  readonly root?: string | undefined;
}

export interface NextjsNodeTarget extends DeployTarget<NextjsNodeTargetConfig> {}

/** Serve-entry module name relative to the project root. */
export const SERVER_ENTRY_NAME = NODE_SERVE_ENTRY_FILE_NAME;

/**
 * Serve-entry statements that start Next in production mode as `app`.
 * Mirrors Next's standalone `server.js`: the resolved build config from
 * `.next/required-server-files.json` is handed over via
 * `__NEXT_PRIVATE_STANDALONE_CONFIG`, so Next never reloads
 * `next.config.*` at runtime (which would recompile TypeScript configs
 * and download SWC into a possibly read-only bundle). Expects `fs`,
 * `path` and `fileURLToPath` in scope (both serve templates import them).
 */
export const NEXT_PRODUCTION_APP_SOURCE = [
  'import next from "next";',
  "const dir = path.dirname(fileURLToPath(import.meta.url));",
  'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, ".next", "required-server-files.json"), "utf8")).config);',
  "const app = next({ dev: false, dir });",
  "await app.prepare();",
].join("\n");

/** The production Next request listener for the shared Node serve entry. */
export const nextNodeServeHandler: NodeServeHandler = {
  kind: "node",
  imports: `${NEXT_PRODUCTION_APP_SOURCE}\nconst nextHandler = app.getRequestHandler();`,
  expr: "nextHandler",
};

const resolveNextCli = (root: string) =>
  Effect.try({
    try: () => {
      const require = createRequire(`${root.replace(/\/+$/, "")}/package.json`);
      return require.resolve("next/dist/bin/next");
    },
    catch: failFramework(
      `Failed to resolve "next" from ${root}. ` +
        "It must be installed in your project.",
    ),
  });

const runNextBuild = (options: {
  readonly root: string;
  readonly cli: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* Effect.sync(() => ({
        ...process.env,
        NODE_ENV: "production",
      }));
      const child = yield* ChildProcess.make("node", [options.cli, "build"], {
        cwd: options.root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
      }).pipe(
        Effect.mapError(
          failFramework(
            "Failed to spawn the next build CLI (is `node` on PATH?)",
          ),
        ),
      );
      const forward = (
        stream: Stream.Stream<Uint8Array, PlatformError>,
        dest: NodeJS.WriteStream,
      ) =>
        Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => dest.write(chunk)),
        );
      const { exitCode } = yield* Effect.all(
        {
          exitCode: child.exitCode,
          stdout: forward(child.stdout, process.stdout),
          stderr: forward(child.stderr, process.stderr),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(failFramework("Failed reading next build output")),
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          failFramework(`The next build exited with code ${exitCode}`)(
            undefined,
          ),
        );
      }
    }),
  );

/** The slice of `.next/required-server-files.json` the build inspects. */
const RequiredServerFiles = Schema.Struct({
  config: Schema.Struct({ output: Schema.optional(Schema.String) }),
});

const collectNextOutput = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nextDir = path.join(root, ".next");
    const hasNext = yield* fs
      .exists(nextDir)
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasNext) {
      return yield* Effect.fail(
        failFramework(`The next build produced no ${nextDir}`)(undefined),
      );
    }
    const serverFilesPath = path.join(nextDir, "required-server-files.json");
    const { config } = yield* fs
      .readFileString(serverFilesPath)
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(RequiredServerFiles),
          ),
        ),
        Effect.mapError(
          failFramework(
            `Failed to read the built Next config ${serverFilesPath}`,
          ),
        ),
      );
    if (config.output === "export") {
      return yield* Effect.fail(
        failFramework(
          '`output: "export"` builds a static site with no Next server, so it ' +
            'cannot run on the Node target. Remove `output: "export"` from ' +
            "next.config, or deploy the exported `out/` directory as a static site.",
        )(undefined),
      );
    }
    const publicDir = path.join(root, "public");
    const hasPublic = yield* fs
      .exists(publicDir)
      .pipe(Effect.orElseSucceed(() => false));
    // No `clientDirExpression`: Next serves `.next/static` and `public/`
    // itself from the serve entry's `dir` (the project root).
    return yield* writeNodeServeEntry({
      output: {
        distDirectory: root,
        clientDirectory: hasPublic ? root : nextDir,
        serverModules: [],
        externalWorkspaces: new Set<string>(),
      },
      servePath: path.join(root, SERVER_ENTRY_NAME),
      serveModuleName: SERVER_ENTRY_NAME,
      handler: nextNodeServeHandler,
    }).pipe(
      Effect.mapError((error) => failFramework(error.message)(error.cause)),
    );
  });

export interface NextjsNodeBuildChildConfig {
  readonly rootDir: string;
  readonly config: NextjsNodeTargetConfig;
}

export const buildInChild = (config: NextjsNodeBuildChildConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = config.rootDir;
    const cli = yield* resolveNextCli(root);
    const spawnerLayer = NodeChildProcessSpawner.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(FileSystem.FileSystem)(fs),
          Layer.succeed(Path.Path)(path),
        ),
      ),
    );
    yield* runNextBuild({ root, cli }).pipe(Effect.provide(spawnerLayer));
    return yield* collectNextOutput(root);
  });

const makeNodeChildTarget = (
  config: NextjsNodeTargetConfig = {},
): NextjsNodeTarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
  });

/**
 * Create the Node {@link NextjsNodeTarget}: wholesale `next build` in a
 * child process, then a custom-server serve entry.
 */
export const makeNodeTarget = (
  config: NextjsNodeTargetConfig = {},
): NextjsNodeTarget => ({
  ...makeNodeChildTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "nextjs",
      config: {
        rootDir: context.root,
        config,
      } satisfies NextjsNodeBuildChildConfig,
    }).pipe(Effect.mapError((error) => failTarget(error.message, error.cause))),
});

export const target = makeNodeTarget;

export default makeNodeTarget;

// ---------------------------------------------------------------------------
// Framework-module contract (AWS.Website.Server / container composites)
// ---------------------------------------------------------------------------

const pickEphemeralPort: Effect.Effect<number, FrameworkCore.FrameworkError> =
  Effect.callback((resume) => {
    const net = createRequire(import.meta.url)("net") as typeof NodeNet;
    const server = net.createServer();
    server.once("error", (cause) =>
      resume(
        Effect.fail(
          failFramework("Failed to allocate an ephemeral port")(cause),
        ),
      ),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(
          Effect.fail(failFramework("No TCP address for the port probe")(null)),
        );
        return;
      }
      const port = address.port;
      server.close(() => resume(Effect.succeed(port)));
    });
  });

interface NextDevChild {
  readonly exited: () => boolean;
  readonly output: () => string;
}

const spawnNextDev = (options: {
  readonly root: string;
  readonly cli: string;
  readonly port: number;
  readonly host?: string | undefined;
}): Effect.Effect<NextDevChild, FrameworkCore.FrameworkError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const cp = createRequire(import.meta.url)(
          "child_process",
        ) as typeof NodeChildProcessModule;
        const child = cp.spawn(
          "node",
          [
            options.cli,
            "dev",
            "-p",
            String(options.port),
            ...(options.host !== undefined ? ["-H", options.host] : []),
          ],
          {
            cwd: options.root,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          },
        );
        let exited = false;
        let output = "";
        const capture = (chunk: unknown) => {
          output += String(chunk);
          if (output.length > 65536) output = output.slice(-32768);
          process.stderr.write(String(chunk));
        };
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        child.once("exit", () => {
          exited = true;
        });
        return {
          child,
          handle: {
            exited: () => exited,
            output: () => output,
          } satisfies NextDevChild,
        };
      },
      catch: failFramework(
        "Failed to spawn the next dev CLI (is `node` on PATH?)",
      ),
    }),
    ({ child }) =>
      Effect.callback<void>((resume) => {
        if (child.exitCode !== null) {
          resume(Effect.void);
          return;
        }
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resume(Effect.void);
        });
        child.kill("SIGTERM");
      }),
  ).pipe(Effect.map(({ handle }) => handle));

/**
 * Poll until the allocated port accepts a TCP connection. Next 16 prints
 * Ready and binds before loading next.config / compiling App Router, so a
 * GET / probe with a 2s abort restarts the first compile and never
 * converges.
 */
const awaitNextDevReady = (options: {
  readonly url: string;
  readonly child: NextDevChild;
}): Effect.Effect<void, FrameworkCore.FrameworkError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => new URL(options.url),
      catch: failFramework(`Invalid next dev URL: ${options.url}`),
    });
    const port = Number(parsed.port);
    const hostname = parsed.hostname;
    for (let attempt = 0; attempt < 240; attempt++) {
      if (options.child.exited()) {
        return yield* Effect.fail(
          failFramework(
            `The next dev CLI exited before becoming ready:\n${options.child.output().slice(-4000)}`,
          )(undefined),
        );
      }
      const ready = yield* Effect.callback<boolean>((resume) => {
        const net = createRequire(import.meta.url)("net") as typeof NodeNet;
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(value));
        };
        const socket = net.connect({ host: hostname, port }, () => {
          socket.destroy();
          finish(true);
        });
        socket.setTimeout(2000, () => {
          socket.destroy();
          finish(false);
        });
        socket.once("error", () => {
          socket.destroy();
          finish(false);
        });
        return Effect.sync(() => {
          settled = true;
          socket.destroy();
        });
      });
      if (ready) return;
      yield* Effect.sleep(500);
    }
    return yield* Effect.fail(
      failFramework(
        `Timed out waiting for the next dev server at ${options.url}`,
      )(undefined),
    );
  });

export interface NextjsNodeService {
  readonly build: (
    options?: FrameworkCore.FrameworkBuildOptions,
  ) => Effect.Effect<
    {
      readonly distDirectory: string;
      readonly clientDirectory: string;
      readonly serverModules: Array<{ readonly name: string }>;
    },
    FrameworkCore.FrameworkError
  >;
  readonly dev: (
    options?: FrameworkCore.FrameworkDevOptions,
  ) => Effect.Effect<
    FrameworkCore.FrameworkDevServer,
    FrameworkCore.FrameworkError,
    Scope.Scope
  >;
}

/**
 * Build the Next.js-on-Node framework service. See the module doc for the
 * `build`/`dev` semantics.
 */
export const make: (
  options?: NextjsNodeOptions,
) => Effect.Effect<
  NextjsNodeService,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.fnUntraced(function* (options?: NextjsNodeOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveRoot = (override: string | undefined) =>
    Effect.sync(() => path.resolve(override ?? options?.root ?? process.cwd()));

  const build: NextjsNodeService["build"] = Effect.fn(function* (
    buildOptions?: FrameworkCore.FrameworkBuildOptions,
  ) {
    const root = yield* resolveRoot(buildOptions?.root);
    const nodeTarget = makeNodeTarget({ root });
    const output = yield* nodeTarget.build!({ root, framework: "nextjs" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) => failFramework(error.message)(error.cause)),
    );
    return {
      distDirectory: output.distDirectory ?? root,
      clientDirectory: output.clientDirectory ?? path.join(root, ".next"),
      serverModules: (output.serverModules ?? []).map((module_) => ({
        name: module_.name,
      })),
    };
  });

  const dev: NextjsNodeService["dev"] = Effect.fn(function* (
    devOptions?: FrameworkCore.FrameworkDevOptions,
  ) {
    const root = yield* resolveRoot(devOptions?.root);
    const port = devOptions?.port ?? (yield* pickEphemeralPort);
    const cli = yield* resolveNextCli(root);
    const host = devOptions?.host ?? "127.0.0.1";
    const child = yield* spawnNextDev({ root, cli, port, host });
    const url = `http://${host}:${port}`;
    yield* awaitNextDevReady({ url, child });
    return { url };
  });

  return { build, dev };
});
