import * as nodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, PlatformError } from "effect";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerEnvironment } from "../Services/ServerEnvironment.ts";
import { ServerEnvironmentLive } from "./ServerEnvironment.ts";

const makeServerEnvironmentLayer = (baseDir: string) =>
  ServerEnvironmentLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

const makeServerConfig = Effect.fn(function* (baseDir: string) {
  const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

  return {
    ...derivedPaths,
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    cwd: process.cwd(),
    baseDir,
    mode: "web",
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    port: 0,
    host: undefined,
    desktopBootstrapToken: undefined,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
  } satisfies ServerConfigShape;
});

it.layer(NodeServices.layer)("ServerEnvironmentLive", (it) => {
  it.effect("persists the environment id across service restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-test-",
      });

      const first = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));
      const second = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(Effect.provide(makeServerEnvironmentLayer(baseDir)));

      expect(first.environmentId).toBe(second.environmentId);
      expect(second.capabilities.repositoryIdentity).toBe(true);
    }),
  );

  it.effect("fails instead of overwriting a persisted id when reading the file errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-read-error-test-",
      });
      const serverConfig = yield* makeServerConfig(baseDir);
      const environmentIdPath = serverConfig.environmentIdPath;
      yield* fileSystem.makeDirectory(nodePath.dirname(environmentIdPath), { recursive: true });
      yield* fileSystem.writeFileString(environmentIdPath, "persisted-environment-id\n");
      const writeAttempts: string[] = [];
      const failingFileSystemLayer = FileSystem.layerNoop({
        exists: (path) => Effect.succeed(path === environmentIdPath),
        readFileString: (path) =>
          path === environmentIdPath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "permission denied",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "not found",
                  pathOrDescriptor: path,
                }),
              ),
        writeFileString: (path) => {
          writeAttempts.push(path);
          return Effect.void;
        },
      });

      const exit = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironmentLive.pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(ServerConfig, serverConfig), failingFileSystemLayer),
            ),
          ),
        ),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(writeAttempts).toEqual([]);
      expect(yield* fileSystem.readFileString(environmentIdPath)).toBe(
        "persisted-environment-id\n",
      );
    }),
  );
});
