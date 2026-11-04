import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexIsolatedRuntime } from "./CodexIsolatedRuntime.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);

it.effect(
  "isolated proxy runtimes keep configuration, sessions and SQLite away from ambient homes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "codex-isolation-" });
      const server = yield* ServerConfig.ServerConfig;
      const userHome = path.join(baseDir, "normal-codex");
      yield* fs.makeDirectory(path.join(userHome, "sessions"), { recursive: true });
      yield* fs.writeFileString(path.join(userHome, "config.toml"), "normal configuration");
      yield* fs.writeFileString(path.join(userHome, "sessions", "normal.jsonl"), "normal history");
      let leases = 0;
      const executable = {
        executablePath: path.join(baseDir, "tools", "codex", "bin", "codex"),
        source: "managed" as const,
        version: "0.166.0",
        managedVersionDirectory: path.join(baseDir, "tools", "codex"),
      };
      const managed = {
        managedDirectory: path.join(baseDir, "tools", "codex"),
        resolve: () => Effect.succeed(executable),
        acquire: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              leases++;
              return executable;
            }),
            () =>
              Effect.sync(() => {
                leases--;
              }),
          ),
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - No compatibility advisory is undefined, not void.
        compatibility: () => Effect.succeed(undefined),
        start: Effect.die("Installation must be explicit"),
        cancel: () => Effect.die("unused"),
        state: Effect.die("unused"),
        changes: Stream.empty,
        remove: () => Effect.die("unused"),
      };
      const config = yield* decodeSettings({
        isolateRuntime: true,
        setupMode: "existing",
        homePath: userHome,
        shadowHomePath: userHome,
        binaryPath: "/system/codex",
        launchArgs: '-c model_provider="proxy"',
      });
      yield* Effect.gen(function* () {
        const first = yield* makeCodexIsolatedRuntime({
          instanceId: ProviderInstanceId.make("codex-a"),
          config,
          environment: {
            CODEX_HOME: userHome,
            CODEX_SQLITE_HOME: userHome,
            OPENAI_BASE_URL: "https://proxy.test/v1",
            OPENAI_API_KEY: "fixture-key",
          },
        });
        const second = yield* makeCodexIsolatedRuntime({
          instanceId: ProviderInstanceId.make("codex-b"),
          config,
          environment: {},
        });
        assert.notEqual(first.homeLayout.continuationKey, second.homeLayout.continuationKey);
        yield* Effect.gen(function* () {
          const runtime = yield* first.resolve;
          assert.equal(leases, 1);
          assert.equal(runtime.config.binaryPath, executable.executablePath);
          assert.equal(
            runtime.config.homePath,
            path.join(server.stateDir, "providers", "codex", "codex-a", "home"),
          );
          assert.equal(runtime.config.shadowHomePath, "");
          assert.equal(runtime.config.launchArgs, config.launchArgs);
          assert.equal(runtime.environment.CODEX_HOME, runtime.config.homePath);
          assert.equal(
            runtime.environment.CODEX_SQLITE_HOME,
            path.join(runtime.config.homePath, "sqlite"),
          );
          assert.equal(runtime.environment.OPENAI_BASE_URL, "https://proxy.test/v1");
          assert.equal(runtime.environment.OPENAI_API_KEY, "fixture-key");
          assert.isFalse(yield* fs.exists(path.join(runtime.config.homePath, "config.toml")));
          assert.isFalse(
            yield* fs.exists(path.join(runtime.config.homePath, "sessions", "normal.jsonl")),
          );
          yield* fs.writeFileString(
            path.join(runtime.config.homePath, "config.toml"),
            "T3 configuration",
          );
        }).pipe(Effect.scoped);
        assert.equal(leases, 0);
        assert.equal(
          yield* fs.readFileString(path.join(userHome, "config.toml")),
          "normal configuration",
        );
        assert.equal(
          yield* fs.readFileString(path.join(userHome, "sessions", "normal.jsonl")),
          "normal history",
        );
      }).pipe(
        Effect.provide(
          Layer.mock(CodexInstallation.CodexInstallation)({
            managedDirectory: managed.managedDirectory,
            managed: Effect.succeed(managed),
          }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-isolated-runtime-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
