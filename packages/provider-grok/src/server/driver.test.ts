import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hasProviderUsageLimits } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";
import * as GrokStatus from "./status.ts";
import * as GrokUsage from "./usageLimits.ts";
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
        Effect.scoped,
      );
    });
  }

  it.effect.each(["subscription", "api-key", "custom-auth", "missing-token", "key-only"] as const)(
    "keeps health-only usage capability accurate for %s",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = GrokDriver.defaultConfig();
          let customAuth = false;
          const readAccount = GrokUsage.readGrokAccount;
          using _account = vi
            .spyOn(GrokUsage, "readGrokAccount")
            .mockImplementation((environment, includeUsage) =>
              Effect.suspend(() =>
                readAccount(
                  {
                    ...environment,
                    ...(customAuth ? { GROK_OIDC_ISSUER: "https://custom.test" } : {}),
                  },
                  includeUsage,
                ),
              ),
            );
          const initial = yield* GrokStatus.buildInitialGrokProviderSnapshot(config);
          using _status = vi.spyOn(GrokStatus, "checkGrokProviderStatus").mockReturnValue(
            Effect.succeed({
              ...initial,
              enabled: true,
              installed: true,
              status: "ready",
              auth: { status: "authenticated", type: "cached_token" },
            }),
          );
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
          const writeCredential = (key: string) =>
            fs.writeFileString(
              `${home}/auth.json`,
              JSON.stringify({ "https://accounts.x.ai/sign-in": { key } }),
            );
          if (mode === "key-only") yield* writeCredential("test-token");
          let requests = 0;
          const instance = yield* GrokDriver.create({
            instanceId: ProviderInstanceId.make("grok-usage"),
            displayName: "Grok test",
            enabled: true,
            config,
            environment: [
              { name: "GROK_HOME", value: home, sensitive: false },
              { name: "XAI_API_KEY", value: mode === "api-key" ? "api-key" : "", sensitive: true },
              {
                name: "GROK_OIDC_ISSUER",
                value: mode === "custom-auth" ? "https://custom.test" : "",
                sensitive: false,
              },
              {
                name: "GROK_AUTH",
                value:
                  mode === "key-only"
                    ? ""
                    : JSON.stringify({
                        "https://accounts.x.ai/sign-in": {
                          key: mode === "missing-token" ? "" : "test-token",
                          email: "account@example.com",
                        },
                      }),
                sensitive: true,
              },
            ],
          }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests += 1;
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    mode === "key-only"
                      ? Response.json({
                          config: {
                            creditUsagePercent:
                              request.headers.authorization === "Bearer test-token" ? 80 : 25,
                          },
                        })
                      : new Response(null, { status: 503 }),
                  ),
                );
              }),
            ),
          );
          const health = yield* instance.snapshot.refresh;
          const supported = mode === "subscription" || mode === "key-only";
          expect(health.auth.email).toBe(
            mode === "api-key" || mode === "custom-auth" || mode === "key-only"
              ? undefined
              : "account@example.com",
          );
          expect(health.supportsUsageLimits).toBe(supported);
          expect(hasProviderUsageLimits(health.driver, [health], [])).toBe(true);
          if (supported) expect(health.usageLimits).toBeUndefined();
          else expect(health.usageLimits?.unavailable?.reason).toBe("unsupported");
          expect(requests).toBe(0);
          yield* instance.snapshot.refreshUsage!;
          const usage = yield* instance.snapshot.getSnapshot;
          expect(usage.usageLimits?.unavailable?.reason).toBe(
            mode === "key-only" ? undefined : supported ? "probeFailed" : "unsupported",
          );
          expect(requests).toBe(supported ? 1 : 0);
          if (mode === "key-only") {
            expect(usage.usageLimits?.windows[0]?.usedPercent).toBe(80);
            yield* writeCredential("account-b");
            const changed = yield* instance.snapshot.refresh;
            expect(requests).toBe(1);
            expect(changed.auth.usageRefreshKey).not.toBe(health.auth.usageRefreshKey);
            expect(changed.usageLimits?.windows.length ?? 0).toBe(0);
            yield* instance.snapshot.refreshUsage!;
            const fresh = yield* instance.snapshot.getSnapshot;
            expect(requests).toBe(2);
            expect(fresh.usageLimits?.windows[0]?.usedPercent).toBe(25);
            yield* writeCredential("account-c");
            yield* instance.snapshot.refreshUsage!;
            expect(requests).toBe(3);
            expect((yield* instance.snapshot.getSnapshot).auth.usageRefreshKey).not.toBe(
              fresh.auth.usageRefreshKey,
            );
            let expectedRequests = requests;
            for (const contents of [
              "{}",
              JSON.stringify({
                "https://accounts.x.ai/sign-in": { auth_mode: "api_key", key: "api-key" },
              }),
            ]) {
              const previous = yield* instance.snapshot.getSnapshot;
              yield* fs.writeFileString(`${home}/auth.json`, contents);
              yield* instance.snapshot.refreshUsage!;
              const removed = yield* instance.snapshot.getSnapshot;
              expect(removed.auth.usageRefreshKey).toBeDefined();
              expect(removed.auth.usageRefreshKey).not.toBe(previous.auth.usageRefreshKey);
              expect(removed.usageLimits?.windows).toEqual([]);
              expect(removed.usageLimits?.unavailable?.reason).toBe("unsupported");
              expect(requests).toBe(expectedRequests);
              yield* writeCredential("account-c");
              yield* instance.snapshot.refreshUsage!;
              expectedRequests += 1;
              expect(requests).toBe(expectedRequests);
            }
            customAuth = true;
            const unsupported = yield* instance.snapshot.refresh;
            expect(unsupported.auth.type).toBe("cached_token");
            expect(unsupported.supportsUsageLimits).toBe(false);
            expect(unsupported.usageLimits?.windows).toEqual([]);
            expect(unsupported.usageLimits?.unavailable?.reason).toBe("unsupported");
            expect(requests).toBe(expectedRequests);
            for (const installed of [true, false]) {
              _status.mockReturnValue(
                Effect.succeed({
                  ...initial,
                  enabled: true,
                  installed,
                  auth: { status: "unauthenticated" },
                }),
              );
              yield* instance.snapshot.refresh;
              yield* instance.snapshot.refreshUsage!;
              const checks = _status.mock.calls.length;
              yield* instance.snapshot.refreshUsage!;
              expect(_status.mock.calls.length).toBe(checks);
              expect(requests).toBe(expectedRequests);
            }
          }
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
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
