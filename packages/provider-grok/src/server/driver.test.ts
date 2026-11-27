import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";
import { GROK_USAGE_URL } from "./usageLimits.ts";
import { resolveLatestProviderVersion } from "@t3tools/provider-core/server/maintenanceResolver";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
  // Each case puts a stub `brew` at `<prefix>/bin/brew` beside the Grok binary.
  const homebrewCases = [
    {
      name: "upgrades a Homebrew grok-build cask through brew",
      binary: ["Caskroom", "grok-build", "1.2.3,456", "grok"],
      reportedPrefix: "own",
      brewArgs: [["--prefix"]],
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
        // npm 12 otherwise skips the postinstall that installs the new binary.
        env: expect.objectContaining({ npm_config_allow_scripts: "@xai-official/grok" }),
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
        expect(capabilities.update).toEqual(update && expect.objectContaining(update));
        if (testCase.latestVersion !== undefined) {
          expect(yield* resolveLatestProviderVersion(capabilities)).toBe(testCase.latestVersion);
          expect(brewArgs).toEqual([...testCase.brewArgs, ["info", "--json=v2", "grok-build"]]);
        }
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
      );
    });
  }

  // `grok update` installs into `$GROK_HOME/bin`, so an instance GROK_HOME that does not own
  // binaryPath would update a different copy and leave the verified binary outdated.
  // `target` is where `bin/grok` links; null is a copied binary, as the Windows installer leaves.
  const scriptInstallCases = [
    { target: "grok-1.0.77", downloads: false, owner: ".grok" },
    { target: "../downloads/grok-linux-x86_64", downloads: true, owner: ".grok" },
    { target: "../downloads/grok-1.0.88-linux-x86_64", downloads: true, owner: ".grok" },
    { target: null, downloads: true, owner: ".grok" },
    { target: null, downloads: false, owner: ".grok-hub" },
  ] as const;
  for (const { target, downloads, owner } of scriptInstallCases) {
    it.effect.skipIf(windowsHost)(
      `runs grok update with GROK_HOME=${owner} for bin/grok -> ${target ?? "copy"}${downloads ? " beside downloads" : ""}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-home-" }),
          );
          const scriptHome = path.join(home, ".grok");
          const binaryPath = path.join(scriptHome, "bin", "grok");
          const targetPath = path.resolve(path.dirname(binaryPath), target ?? "grok");
          yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
          if (downloads) {
            yield* fs.makeDirectory(path.join(scriptHome, "downloads"), { recursive: true });
          }
          yield* fs.writeFileString(targetPath, "#!/bin/sh\n");
          yield* fs.chmod(targetPath, 0o755);
          if (target) yield* fs.symlink(target, binaryPath);

          const instance = yield* GrokDriver.create({
            instanceId: ProviderInstanceId.make("grok-separate-home"),
            displayName: "Grok test",
            enabled: false,
            environment: [
              { name: "GROK_HOME", value: path.join(home, ".grok-hub"), sensitive: false },
            ],
            config: { ...GrokDriver.defaultConfig(), binaryPath },
          });
          const { update } = yield* instance.snapshot.resolveMaintenance();

          expect(update).toEqual(
            expect.objectContaining({
              executable: binaryPath,
              args: ["update"],
              env: expect.objectContaining({ GROK_HOME: path.join(home, owner) }),
            }),
          );
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
    );
  }

  // An `npx t3` server inherits npm_config_user_agent, which Grok ranks above `[cli] installer`.
  it.effect.skipIf(windowsHost)("keeps a script install off the npm updater under npx", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-" }));
      const downloaded = path.join(home, ".grok", "downloads", "grok-linux-x86_64");
      const binaryPath = path.join(home, ".grok", "bin", "grok");
      yield* fs.makeDirectory(path.dirname(downloaded), { recursive: true });
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(downloaded, "#!/bin/sh\n");
      yield* fs.chmod(downloaded, 0o755);
      yield* fs.symlink(downloaded, binaryPath);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-script"),
        displayName: "Grok test",
        enabled: false,
        environment: [
          {
            name: "npm_config_user_agent",
            value: "npm/11.6.2 node/v24.11.0 linux x64 workspaces/false",
            sensitive: false,
          },
        ],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });
      const updateEnv = (yield* instance.snapshot.resolveMaintenance()).update?.env ?? {};
      // The maintenance runner spawns with extendEnv, layering this over the server's process.env.
      const env: NodeJS.ProcessEnv = {
        npm_config_user_agent: "npm/11.6.2 node/v24.11.0",
        ...updateEnv,
      };
      expect(env.GROK_INSTALLER === "internal" || env.npm_config_user_agent === undefined).toBe(
        true,
      );
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
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
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
  );
});

const layerUsageTest = TestProviderHost.layer().pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

it.layer(layerUsageTest)("GrokDriver usage limits", (it) => {
  it.effect.skipIf(windowsHost)(
    "re-reads usage limits on the refresh interval and starts the CLI only to renew a rejected key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
        const launches = path.join(home, "launches");
        yield* fs.writeFileString(launches, "");
        yield* fs.writeFileString(
          path.join(home, "auth.json"),
          JSON.stringify({
            "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
              key: "session-token",
              auth_mode: "oidc",
            },
          }),
        );
        const agentPath = yield* path.fromFileUrl(
          new URL("./testFixtures/grok-model-selection-agent.mjs", import.meta.url),
        );
        const binaryPath = writeFakeCli({
          directory: home,
          name: "grok",
          source: [
            'import { appendFileSync } from "node:fs";',
            'import { pathToFileURL } from "node:url";',
            `appendFileSync(${JSON.stringify(launches)}, ".");`,
            'if (process.argv[2] === "--version") {',
            '  process.stdout.write("grok 1.0.13\\n");',
            "  process.exit(0);",
            "}",
            'if (process.argv[2] === "models") {',
            '  process.stdout.write("You are logged in with grok.com.\\n\\nAvailable models:\\n  * grok-4.6 (default)\\n");',
            "  process.exit(0);",
            "}",
            'if (process.argv[2] !== "agent") process.exit(1);',
            `await import(pathToFileURL(${JSON.stringify(agentPath)}).href);`,
          ].join("\n"),
        });
        // Each billing request takes the next answer: a used percent, or 401 for a rejected key.
        const billing: Array<number | 401> = [97, 9, 401, 401, 401, 12, 401, 30, 401, 40, 401, 50];
        const served = yield* Queue.unbounded<void>();
        const httpClient = HttpClient.make((request) => {
          // Only Grok's billing endpoint answers; version advisories see an unknown latest version.
          if (request.url !== GROK_USAGE_URL) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
            );
          }
          const answer = billing.shift();
          return Queue.offer(served, undefined).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                answer === 401
                  ? Response.json({ error: "unauthorized" }, { status: 401 })
                  : Response.json({ config: { creditUsagePercent: answer } }),
              ),
            ),
          );
        });

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-usage"),
          displayName: "Grok test",
          enabled: true,
          environment: [
            { name: "GROK_HOME", value: home, sensitive: false },
            { name: "XAI_API_KEY", value: "", sensitive: false },
          ],
          config: { ...GrokDriver.defaultConfig(), binaryPath },
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        const launchCount = fs.readFileString(launches).pipe(Effect.map((text) => text.length));
        // Waits for the billing requests a step makes; a full check reads billing after its CLI
        // runs, so the launch count is settled once its request arrives.
        const readingAfter = (adjust: Effect.Effect<void>, requests: number, percent: number) =>
          Effect.gen(function* () {
            const reading = yield* instance.snapshot.streamChanges.pipe(
              Stream.filter(
                (snapshot) =>
                  snapshot.status === "ready" &&
                  snapshot.usageLimits?.windows[0]?.usedPercent === percent,
              ),
              Stream.runHead,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* adjust;
            for (let request = 0; request < requests; request++) yield* Queue.take(served);
            yield* Fiber.join(reading);
            return yield* launchCount;
          });
        const nextInterval = TestClock.adjust("5 minutes");

        const started = yield* readingAfter(Effect.void, 1, 97);
        expect(yield* readingAfter(nextInterval, 1, 9)).toBe(started);

        // A rejected key runs the full check, which starts the CLI to renew it; here it stays rejected.
        const renewed = yield* readingAfter(nextInterval, 2, 9);
        expect(renewed).toBeGreaterThan(started);
        // While reads keep failing, the CLI is not started again.
        expect(yield* readingAfter(nextInterval, 1, 9)).toBe(renewed);
        expect(yield* readingAfter(nextInterval, 1, 12)).toBe(renewed);

        // Once a read succeeds, the next rejection runs the full check again, and so does the
        // rejection after a full check that read successfully.
        const renewedAgain = yield* readingAfter(nextInterval, 2, 30);
        expect(renewedAgain).toBeGreaterThan(renewed);
        const renewedThird = yield* readingAfter(nextInterval, 2, 40);
        expect(renewedThird).toBeGreaterThan(renewedAgain);

        // A manual refresh that meets the first rejection renews the key the same way.
        const refreshUsage = Effect.orDie(instance.snapshot.refreshUsage ?? Effect.void);
        expect(yield* readingAfter(refreshUsage, 2, 50)).toBeGreaterThan(renewedThird);
        expect(billing).toEqual([]);
      }),
  );
});
