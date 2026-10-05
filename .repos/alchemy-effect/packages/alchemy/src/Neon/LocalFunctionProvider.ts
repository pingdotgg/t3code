import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as LocalProvider from "../Local/LocalProvider.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { moduleExtension } from "../Util/Node.ts";
import { sha256 } from "../Util/sha256.ts";
import { Function } from "./Function.ts";
import {
  buildFunctionArtifact,
  validateFunctionZip,
} from "./FunctionArtifact.ts";
import {
  FunctionConfigurationError,
  functionEnvironment,
  functionSlug,
} from "./FunctionConfig.ts";

export const LocalFunctionProvider = () =>
  LocalProvider.make(
    Function,
    import.meta.resolve(`./LocalFunction${moduleExtension(import.meta.url)}`),
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return {
        resolveConfig: Effect.fn(function* ({ news, bindings }) {
          const source = news.main
            ? news.main.startsWith("file:")
              ? yield* path.fromFileUrl(new URL(news.main))
              : news.main
            : news.artifact?.zip;
          const hash = source
            ? yield* fs.readFile(source).pipe(Effect.flatMap(sha256))
            : (yield* buildFunctionArtifact(news)).codeHash;
          return { news, bindings, hash };
        }),
        start: Effect.fn(function* ({
          id,
          instanceId,
          news,
          bindings,
          invalidate,
        }) {
          const command = news.dev?.command ?? "neon";
          const version = yield* spawner
            .string(ChildProcess.make(command, ["--version"]))
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.mapError(
                (cause) =>
                  new FunctionConfigurationError({
                    message:
                      cause._tag === "PlatformError" &&
                      cause.reason._tag === "NotFound"
                        ? `Neon CLI executable '${command}' was not found. Install Neon CLI >=2.45.0: https://neon.com/cli . Ensure '${command}' is on PATH, or set Function.dev.command to its executable path. Local Functions also require Node 24.`
                        : `Could not run '${command} --version': ${cause.message}`,
                    cause,
                  }),
              ),
            );
          const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
          if (
            !match ||
            Number(match[1]) < 2 ||
            (Number(match[1]) === 2 && Number(match[2]) < 45)
          )
            return yield* new FunctionConfigurationError({
              message: "Local Function WebSockets require Neon CLI >=2.45.0",
            });
          const nodeVersion = yield* spawner.string(
            ChildProcess.make("node", ["--version"]),
          );
          if (!/^v24\./.test(nodeVersion.trim()))
            return yield* new FunctionConfigurationError({
              message: "Local Functions require Node 24",
            });
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-neon-function-",
          });
          const writeArtifact = Effect.gen(function* () {
            const artifact = yield* buildFunctionArtifact(news);
            const files = yield* validateFunctionZip(artifact.archive);
            for (const [name, content] of Object.entries(files)) {
              if (name.endsWith("/")) continue;
              const file = path.join(root, name);
              yield* fs.makeDirectory(path.dirname(file), { recursive: true });
              yield* fs.writeFile(file, content);
            }
            return artifact.codeHash;
          });
          const codeHash = yield* writeArtifact;
          const slug = yield* functionSlug(id, news.slug);
          const env = yield* functionEnvironment(news, bindings);
          const stack = yield* Stack;
          const stage = yield* Stage;
          const base = yield* Effect.sync(() =>
            Object.fromEntries(
              ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
                process.env[key] ? [[key, process.env[key]!]] : [],
              ),
            ),
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(
              command,
              [
                "dev",
                "--source",
                path.join(root, "index.mjs"),
                ...(news.dev?.port ? ["--port", String(news.dev.port)] : []),
              ],
              {
                cwd: root,
                env: {
                  ...base,
                  ...env,
                  ALCHEMY_STACK_NAME: stack.name,
                  ALCHEMY_STAGE: stage,
                  ALCHEMY_PHASE: "runtime",
                },
                extendEnv: false,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              },
            ),
          );
          const ready = yield* Deferred.make<string>();
          const capture = (
            stream: Stream.Stream<
              Uint8Array,
              import("effect/PlatformError").PlatformError
            >,
          ) =>
            stream.pipe(
              Stream.decodeText,
              Stream.runForEach((text) => {
                const url = text.match(
                  /http:\/\/(?:localhost|127\.0\.0\.1):\d+/,
                )?.[0];
                return url ? Deferred.succeed(ready, url) : Effect.void;
              }),
              Effect.forkScoped,
            );
          yield* capture(child.stdout);
          yield* capture(child.stderr);
          const url = yield* Effect.raceAllFirst([
            Deferred.await(ready).pipe(Effect.timeout("15 seconds")),
            child.exitCode.pipe(
              Effect.flatMap(
                () =>
                  new FunctionConfigurationError({
                    message:
                      "Neon local runtime exited before readiness; install Neon CLI >=2.45.0 and Node 24",
                  }),
              ),
            ),
          ]);
          yield* child.exitCode.pipe(
            Effect.exit,
            Effect.andThen(invalidate),
            Effect.forkScoped,
          );
          const watched =
            news.main ?? news.artifact?.directory ?? news.artifact?.zip;
          if (watched) {
            const source = watched.startsWith("file:")
              ? yield* path.fromFileUrl(new URL(watched))
              : path.resolve(watched);
            const directory = news.artifact?.directory
              ? source
              : path.dirname(source);
            yield* fs.watch(directory, { recursive: true }).pipe(
              Stream.runForEach(() =>
                writeArtifact.pipe(
                  Effect.ignoreCause({
                    log: "Error",
                    message: "Neon Function rebuild failed",
                  }),
                ),
              ),
              Effect.forkScoped,
            );
          }
          const projectId =
            news.branch?.projectId ?? news.project?.projectId ?? "local";
          const branchId = news.branch?.branchId ?? "local";
          return {
            projectId,
            branchId,
            functionId: `dev:${instanceId}`,
            slug,
            name: news.name ?? slug,
            url,
            currentDeploymentId: undefined,
            activeDeploymentId: undefined,
            status: "local",
            codeHash,
            environment: Object.keys(env),
          };
        }),
      };
    }),
  );
