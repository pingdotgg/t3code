import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import * as NodeV8 from "node:v8";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { BundleError } from "../../Bundle/Bundle.ts";
import {
  fromProcessEnv,
  RPC_SERVER_ENVIRONMENT_KEY,
  type RpcServerEnvironment,
} from "../../Local/RpcServerEnvironment.ts";
import { Stack } from "../../Stack.ts";
import { transformTypesFlags } from "../../Util/Node.ts";
import { unwrapRedacted } from "../../Util/index.ts";
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
  fileURLToPath(
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? `./${basename}.ts` : `./${basename}.js`,
    ),
  );

export const startViteChild = (
  config: ViteChildConfig,
  onOutput: (channel: "stdout" | "stderr", line: string) => void,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runner = resolveRunner("ViteChildRunner");
    const isBun = typeof globalThis.Bun !== "undefined";
    // A source provider can pin the dev child to node (e.g. `next dev`
    // cold-starts broken under bun). Honored only when node is installed;
    // otherwise fall back to the engine's own runtime.
    const nodeExecPath =
      isBun && config.source?.descriptor.runtime === "node"
        ? (globalThis.Bun.which("node") ?? undefined)
        : undefined;
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
    const child = yield* spawner.spawn(
      ChildProcess.make(
        nodeExecPath ?? process.execPath,
        isBun && nodeExecPath === undefined
          ? ["run", runner]
          : [...(runner.endsWith(".ts") ? transformTypesFlags() : []), runner],
        {
          cwd: config.rootDir,
          stdin: Stream.succeed(serializedConfig),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(childEnvironment),
          },
          extendEnv: true,
          killSignal: "SIGKILL",
        },
      ),
    );

    const ready = yield* Deferred.make<URL>();
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const start = line.indexOf(VITE_CHILD_READY_PREFIX);
        const end = line.indexOf(VITE_CHILD_READY_SUFFIX);
        if (start !== -1 && end > start) {
          const value = line.slice(start + VITE_CHILD_READY_PREFIX.length, end);
          return Deferred.succeed(ready, new URL(value));
        }
        return Effect.sync(() => onOutput("stdout", line));
      }),
      Effect.forkScoped,
    );
    yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => onOutput("stderr", line))),
      Effect.forkScoped,
    );

    const exitCode = child.exitCode.pipe(Effect.orDie);
    const url = yield* Effect.raceAllFirst([
      Deferred.await(ready),
      exitCode.pipe(
        Effect.flatMap((exitCode) =>
          Effect.die(
            new Error(
              `Vite child exited with code ${exitCode} before becoming ready`,
            ),
          ),
        ),
      ),
    ]);
    return { url, pid: child.pid, exitCode } satisfies ViteChildHandle;
  });

/** Number of trailing output lines echoed into a failed build's error. */
const BUILD_ERROR_TAIL = 50;

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
  onOutput: (channel: "stdout" | "stderr", line: string) => void,
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
      const serializedConfig = NodeV8.serialize(
        unwrapRedacted({ ...config, outputPath }),
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          isBun
            ? ["run", runner]
            : [
                ...(runner.endsWith(".ts") ? transformTypesFlags() : []),
                runner,
              ],
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
            env: { NODE_ENV: "production" },
            killSignal: "SIGKILL",
          },
        ),
      );

      const tail: string[] = [];
      const forward = (channel: "stdout" | "stderr") => (line: string) =>
        Effect.sync(() => {
          tail.push(line);
          if (tail.length > BUILD_ERROR_TAIL) tail.shift();
          onOutput(channel, line);
        });
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
        return yield* Effect.fail(
          new BundleError({
            message: `Vite build child exited with code ${exitCode}:\n${tail.join("\n")}`,
          }),
        );
      }
      const bytes = yield* fs.readFile(outputPath).pipe(Effect.orDie);
      return NodeV8.deserialize(Buffer.from(bytes)) as ViteBuildChildResult;
    }),
  );
