import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

/** Answers every spawn with `onSpawn(command, args)` on stdout, like a stub `brew`. */
function stdoutSpawner(onSpawn: (command: string, args: ReadonlyArray<string>) => string) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)("upgrades a Homebrew grok-build cask through brew", () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    let prefix = "";
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      prefix = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-homebrew-" }),
      );
      const brewPath = path.join(prefix, "bin", "brew");
      const binaryPath = path.join(prefix, "Caskroom", "grok-build", "1.2.3,456", "grok");
      for (const executable of [brewPath, binaryPath]) {
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-homebrew"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });
      const capabilities = yield* instance.snapshot.resolveMaintenance();

      expect(spawned).toEqual([
        [brewPath, "--prefix"],
        [brewPath, "info", "--json=v2", "grok-build"],
      ]);
      expect(capabilities).toEqual({
        provider: "grok",
        packageName: "@xai-official/grok",
        latestVersion: "1.2.4",
        update: {
          command: "brew upgrade --cask grok-build",
          executable: brewPath,
          args: ["upgrade", "--cask", "grok-build"],
          lockKey: "homebrew",
        },
      });
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        stdoutSpawner((command, args) => {
          spawned.push([command, ...args]);
          return args[0] === "--prefix"
            ? `${prefix}\n`
            : JSON.stringify({ casks: [{ version: "1.2.4,789" }] });
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect.skipIf(windowsHost)(
    "stays manual-only for a cask-shaped path another brew prefix owns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-foreign-brew-" }),
        );
        const brewPath = path.join(tempDir, "bin", "brew");
        const binaryPath = path.join(tempDir, "Caskroom", "grok-build", "1.2.3", "grok");
        for (const executable of [brewPath, binaryPath]) {
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "#!/bin/sh\n");
          yield* fs.chmod(executable, 0o755);
        }

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-foreign-brew"),
          displayName: "Grok test",
          enabled: false,
          environment: [],
          config: { ...GrokDriver.defaultConfig(), binaryPath },
        });
        const capabilities = yield* instance.snapshot.resolveMaintenance();

        expect(capabilities).toEqual({
          provider: "grok",
          packageName: "@xai-official/grok",
          update: null,
        });
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner(() => "/opt/homebrew\n"),
        ),
        Effect.scoped,
      ),
  );

  it.effect.skipIf(windowsHost)("stays manual-only for a cask-shaped path with no brew", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-no-brew-" }),
      );
      const emptyBin = path.join(tempDir, "empty-bin");
      const binaryPath = path.join(tempDir, "Caskroom", "grok-build", "1.2.3", "grok");
      yield* fs.makeDirectory(emptyBin, { recursive: true });
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-no-brew"),
        displayName: "Grok test",
        enabled: false,
        // No keg-local brew and nothing on PATH, so no `brew` can be found.
        environment: [{ name: "PATH", value: emptyBin, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      expect(yield* instance.snapshot.resolveMaintenance()).toEqual({
        provider: "grok",
        packageName: "@xai-official/grok",
        update: null,
      });
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)(
    "keeps grok update for an npm global inside a Homebrew node keg",
    () => {
      const spawned: Array<ReadonlyArray<string>> = [];
      let prefix = "";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        prefix = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-node-keg-" }),
        );
        const brewPath = path.join(prefix, "bin", "brew");
        const binaryPath = path.join(
          prefix,
          "Cellar",
          "node",
          "22.1.0",
          "lib",
          "node_modules",
          "@xai-official",
          "grok",
          "bin",
          "grok",
        );
        for (const executable of [brewPath, binaryPath]) {
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "#!/bin/sh\n");
          yield* fs.chmod(executable, 0o755);
        }

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-node-keg"),
          displayName: "Grok test",
          enabled: false,
          environment: [],
          config: { ...GrokDriver.defaultConfig(), binaryPath },
        });
        const capabilities = yield* instance.snapshot.resolveMaintenance();

        expect(spawned).toEqual([]);
        expect(capabilities.latestVersion).toBeUndefined();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "grok",
        });
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((command, args) => {
            spawned.push([command, ...args]);
            return args[0] === "--prefix"
              ? `${prefix}\n`
              : JSON.stringify({ formulae: [{ versions: { stable: "24.0.0" } }] });
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
