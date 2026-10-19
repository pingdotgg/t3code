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

  // Each case puts a stub `brew` at `<prefix>/bin/brew` beside the Grok binary.
  const homebrewCases = [
    {
      name: "upgrades a Homebrew grok-build cask through brew",
      binary: ["Caskroom", "grok-build", "1.2.3,456", "grok"],
      reportedPrefix: "own",
      brewArgs: [["--prefix"], ["info", "--json=v2", "grok-build"]],
      latestVersion: "1.2.4",
      update: (brewPath: string, _binaryPath: string) => ({
        command: "brew upgrade --cask grok-build",
        executable: brewPath,
        args: ["upgrade", "--cask", "grok-build"],
        lockKey: "homebrew",
      }),
    },
    {
      // `grok update` would install a second copy beside the cask.
      name: "stays manual-only for a cask another brew prefix owns",
      binary: ["Caskroom", "grok-build", "1.2.3", "grok"],
      reportedPrefix: "/opt/homebrew",
      brewArgs: [["--prefix"]],
      latestVersion: undefined,
      update: () => null,
    },
    {
      // A formula keg such as `node` holding an npm global is not Grok's owner.
      name: "keeps grok update for an npm global inside a Homebrew node keg",
      binary: [
        "Cellar",
        "node",
        "22",
        "lib",
        "node_modules",
        "@xai-official",
        "grok",
        "bin",
        "grok",
      ],
      reportedPrefix: "own",
      brewArgs: [],
      latestVersion: undefined,
      update: (_brewPath: string, binaryPath: string) => ({
        executable: binaryPath,
        args: ["update"],
        lockKey: "grok",
      }),
    },
  ] as const;

  for (const testCase of homebrewCases) {
    it.effect.skipIf(windowsHost)(testCase.name, () => {
      const brewArgs: Array<ReadonlyArray<string>> = [];
      let prefix = "";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        prefix = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-brew-" }));
        const brewPath = path.join(prefix, "bin", "brew");
        const binaryPath = path.join(prefix, ...testCase.binary);
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

        const update = testCase.update(brewPath, binaryPath);
        expect(brewArgs).toEqual(testCase.brewArgs);
        expect(capabilities.latestVersion).toBe(testCase.latestVersion);
        expect(capabilities.update).toEqual(update && expect.objectContaining(update));
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((command, args) => {
            expect(command).toBe(`${prefix}/bin/brew`);
            brewArgs.push(args);
            if (args[0] === "--prefix") {
              return `${testCase.reportedPrefix === "own" ? prefix : testCase.reportedPrefix}\n`;
            }
            return JSON.stringify({ casks: [{ version: "1.2.4,789" }] });
          }),
        ),
        Effect.scoped,
      );
    });
  }

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
