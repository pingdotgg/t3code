import { fileURLToPath } from "node:url";
import * as NodeV8 from "node:v8";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { BundleError } from "alchemy/Bundle/Bundle";
import {
  fromProcessEnv,
  RPC_SERVER_ENVIRONMENT_KEY,
  type RpcServerEnvironment,
} from "alchemy/Local/RpcServerEnvironment";
import { Stack } from "alchemy/Stack";
import { unwrapRedacted } from "alchemy/Util";
import { nodeLoaderArgs } from "alchemy/Util/Node";
import { moduleExtension } from "alchemy/Util/Node";
import { pipedColorEnv } from "alchemy/Util/Terminal";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import {
  type ViteBuildChildConfig,
  type ViteBuildChildResult,
  type ViteChildConfig,
  VITE_CHILD_READY_PREFIX,
  VITE_CHILD_READY_SUFFIX,
} from "./ViteChild.shared.ts";

export interface ViteChildHandle {
  readonly url: URL;
  readonly pid: number;
  readonly exitCode: Effect.Effect<number>;
}

// Resolved lazily at spawn time, NOT at module load: this module can be
// carried into bundled user code (Workers), where `import.meta.resolve`
// does not exist (workerd) — a module-level call would crash the bundle
// at startup even though no child is ever spawned there. At spawn time
// we are guaranteed to be in Node/bun.
const resolveRunner = (basename: string) =>
  fileURLToPath(import.meta.resolve(`./${basename}${moduleExtension(import.meta.url)}`));

// The runner for a Node child spawned from Bun. Bun runs a published
// install from `src/*.ts` (the `bun` export condition), but Node can't load
// that: `nodeLoaderArgs` pairs a `.ts` entry with the checkout-only
// `bin/register-dev-mode.js` (not published), and `bin/register-oxc.js`
// leaves `node_modules` untranspiled. The package ships `lib/` beside `src/`,
// so an installed copy hands Node the built runner (loaded under
// `bin/register-oxc.js`); a checkout keeps the source runner.
const resolveNodeRunner = (basename: string) => {
  const runner = resolveRunner(basename);
  return /[\\/]node_modules[\\/]/.test(runner) && runner.endsWith(".ts")
    ? fileURLToPath(new URL(`../../lib/Workers/${basename}.js`, import.meta.url))
    : runner;
};

export const startViteChild = (
  config: ViteChildConfig,
  onOutput: (channel: "stdout" | "stderr", line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const isBun = typeof globalThis.Bun !== "undefined";
    // The dev server runs on node, as `@cloudflare/vite-plugin`'s does,
    // whenever node is installed; otherwise on the engine's own runtime.
    // Bun 1.3's `node:http` drops all but the last of repeated response
    // headers and never delivers bytes written to an upgraded socket, so a
    // Vite dev server on it loses `server.headers` arrays and WebSockets.
    const nodeExecPath = isBun ? (globalThis.Bun.which("node") ?? undefined) : undefined;
    const runner =
      nodeExecPath !== undefined
        ? resolveNodeRunner("ViteChildRunner")
        : resolveRunner("ViteChildRunner");
    // Redacted values can't cross the process boundary — the config is
    // plain data once unwrapped. bun's `v8.serialize` output is not
    // readable by real V8 (and vice versa), so a cross-runtime spawn
    // sends JSON instead; the runner sniffs the encoding (V8 payloads
    // start with 0xFF, JSON with `{`).
    const serializedConfig =
      nodeExecPath !== undefined
        ? Buffer.from(JSON.stringify(unwrapRedacted(config)))
        : NodeV8.serialize(unwrapRedacted(config));
    // The Vite child boots the legacy single-stack environment
    // (RpcServerEnvironment.fromEnv). The sidecar's own process env no
    // longer carries a stack (one sidecar serves many stacks; sessions
    // carry theirs), so pass the CURRENT session's stack explicitly, with
    // profile/envFile taken from the sidecar's spawn-time env when present.
    // Resolved via serviceOption so this helper's requirements stay
    // unchanged; the provider context this runs in always carries both.
    const alchemyContext = yield* Effect.serviceOption(AlchemyContext);
    const stack = yield* Effect.serviceOption(Stack);
    const base = yield* fromProcessEnv.pipe(
      Effect.orElseSucceed((): RpcServerEnvironment => ({
        profile: process.env.ALCHEMY_PROFILE,
        envFile: undefined,
      })),
    );
    const childEnvironment: RpcServerEnvironment = {
      profile: base.profile,
      envFile: base.envFile,
      alchemyContext: Option.getOrElse(
        alchemyContext,
        () => base.alchemyContext as AlchemyContext["Service"],
      ),
      stack: Option.getOrElse(
        Option.map(stack, (s) => ({ name: s.name, stage: s.stage })),
        () => base.stack as { name: string; stage: string },
      ),
    };
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(childEnvironment),
    };
    // The parent CLI process sets NODE_ENV for its own React/renderer
    // needs; that hack must not leak into the user's dev server (Vite
    // derives its default mode from NODE_ENV, so an inherited value would
    // silently override the project's own mode).
    delete childEnv.NODE_ENV;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        nodeExecPath ?? process.execPath,
        isBun && nodeExecPath === undefined ? ["run", runner] : [...nodeLoaderArgs(runner), runner],
        {
          cwd: config.rootDir,
          stdin: Stream.succeed(serializedConfig),
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv,
          extendEnv: false,
          // SIGTERM lets the child close its runtime, whose finalizer removes
          // the Docker containers its Workers started (`ctx.container`);
          // SIGKILL would leave them running.
          killSignal: "SIGTERM",
          forceKillAfter: "10 seconds",
        },
      ),
    );

    const ready = yield* Deferred.make<URL>();
    // The last output lines explain a child that dies before it is ready
    // (an entry that can't be resolved, a broken Vite config).
    const outputTail: Array<string> = [];
    const recordOutput = (stream: "stdout" | "stderr", line: string) =>
      Effect.sync(() => {
        outputTail.push(line);
        if (outputTail.length > STARTUP_ERROR_TAIL) outputTail.shift();
      }).pipe(Effect.andThen(onOutput(stream, line)));
    const stdout = yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const start = line.indexOf(VITE_CHILD_READY_PREFIX);
        const end = line.indexOf(VITE_CHILD_READY_SUFFIX);
        if (start !== -1 && end > start) {
          const value = line.slice(start + VITE_CHILD_READY_PREFIX.length, end);
          return Deferred.succeed(ready, new URL(value));
        }
        return recordOutput("stdout", line);
      }),
      Effect.forkScoped,
    );
    const stderr = yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => recordOutput("stderr", line)),
      Effect.forkScoped,
    );

    const exitCode = child.exitCode.pipe(Effect.orDie);
    const url = yield* Effect.raceAllFirst([
      Deferred.await(ready),
      exitCode.pipe(
        Effect.tap(() =>
          Fiber.joinAll([stdout, stderr]).pipe(Effect.timeout("1 second"), Effect.ignore),
        ),
        Effect.flatMap((exitCode) =>
          Effect.die(
            new Error(
              [`Vite child exited with code ${exitCode} before becoming ready`, ...outputTail].join(
                "\n",
              ),
            ),
          ),
        ),
      ),
    ]);
    return { url, pid: child.pid, exitCode } satisfies ViteChildHandle;
  });

/** Number of trailing output lines echoed into a failed dev start's error. */
const STARTUP_ERROR_TAIL = 50;

/** Number of trailing stderr lines echoed into a failed build's error. */
const BUILD_ERROR_TAIL = 200;

/**
 * Run a one-shot production Vite build in a child process whose working
 * directory is the project root, and read back the serialized result.
 *
 * Isolation is the point (the dev server already runs this way): an
 * in-process build both suffers from and causes transient `process.cwd()`
 * changes — cross-spawn `process.chdir`s the hosting process while
 * resolving a spawn's binary, and vite/plugins resolve relative paths
 * against live cwd — which corrupts concurrent deploys sharing the
 * process. See `ViteBuildChildRunner.ts` for the child side.
 */
export const runViteBuildChild = (
  config: Omit<ViteBuildChildConfig, "outputPath">,
  onOutput: (channel: "stdout" | "stderr", line: string) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runner = resolveRunner("ViteBuildChildRunner");
      const isBun = typeof globalThis.Bun !== "undefined";
      const outputDir = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-vite-build-",
      });
      const outputPath = path.join(outputDir, "result.v8");
      // Redacted values can't cross the process boundary — the config is
      // plain data once unwrapped.
      const serializedConfig = NodeV8.serialize(unwrapRedacted({ ...config, outputPath }));
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          isBun ? ["run", runner] : [...nodeLoaderArgs(runner), runner],
          {
            cwd: config.rootDir,
            stdin: Stream.succeed(serializedConfig),
            stdout: "pipe",
            stderr: "pipe",
            extendEnv: true,
            // A production build must not inherit the parent's NODE_ENV: a
            // deploy driven from a test process (`bun test` sets
            // NODE_ENV=test) would otherwise bake `import.meta.env.DEV`
            // into the server bundle (e.g. SolidStart then ships its
            // dev-only manifest and every SSR request 500s).
            env: { ...pipedColorEnv(), NODE_ENV: "production" },
            killSignal: "SIGKILL",
          },
        ),
      );

      // stdout is build progress; the failure cause lands on stderr.
      const stderrTail: string[] = [];
      let stderrLines = 0;
      const forward = (channel: "stdout" | "stderr") => (line: string) =>
        Effect.sync(() => {
          if (channel !== "stderr") return;
          stderrLines++;
          stderrTail.push(line);
          if (stderrTail.length > BUILD_ERROR_TAIL) stderrTail.shift();
        }).pipe(Effect.andThen(onOutput(channel, line)));
      const stdoutFiber = yield* Effect.forkChild(
        child.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach(forward("stdout")),
        ),
      );
      const stderrFiber = yield* Effect.forkChild(
        child.stderr.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach(forward("stderr")),
        ),
      );

      const exitCode = yield* child.exitCode.pipe(Effect.orDie);
      // Drain both pipes before reporting so the error tail is complete.
      yield* Fiber.join(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.join(stderrFiber).pipe(Effect.ignore);
      if (exitCode !== 0) {
        const truncated = stderrLines > stderrTail.length;
        return yield* BundleError.make({
          message: [
            `Vite build child exited with code ${exitCode}.`,
            ...(stderrTail.length === 0
              ? []
              : [
                  truncated ? `stderr (last ${stderrTail.length} lines):` : "stderr:",
                  ...stderrTail,
                ]),
          ].join("\n"),
        });
      }
      const bytes = yield* fs.readFile(outputPath).pipe(Effect.orDie);
      return NodeV8.deserialize(Buffer.from(bytes)) as ViteBuildChildResult;
    }),
  );
