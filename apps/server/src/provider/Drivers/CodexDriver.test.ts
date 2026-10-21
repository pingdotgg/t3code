import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import { selectLaunchCandidate } from "../../orchestration-v2/DelegatedLaunchAdmission.ts";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { CodexDriver } from "./CodexDriver.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(layerTest)("CodexDriver", (it) => {
  it.effect(
    "preserves exhausted direct-account identity across models, allows independent capacity and denies pools",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homePath = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          `${homePath}/models_cache.json`,
          JSON.stringify({ fetched_at: DateTime.formatIso(yield* DateTime.now) }),
        );
        let provider = "openai";
        let starts = 0;
        let usage = 1;
        let ordinaryUsageAllowed = true;
        let accountId = "backend-account";
        let email = "direct@example.com";
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const output = yield* Queue.unbounded<Uint8Array>();
            const stopped = yield* Deferred.make<void>();
            const version =
              ChildProcess.isStandardCommand(command) && command.args.includes("--version");
            yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: version
                ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                : Deferred.await(stopped).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Deferred.isDone(stopped).pipe(Effect.map((done) => !done)),
              kill: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((bytes: Uint8Array) =>
                Effect.forEach(
                  new TextDecoder().decode(bytes).split("\n").filter(Boolean),
                  (line) => {
                    const { id, method } = JSON.parse(line) as { id?: number; method: string };
                    if (id === undefined) return Effect.void;
                    if (method === "turn/start") starts++;
                    const result =
                      method === "initialize"
                        ? {
                            userAgent: "codex/0.163.0",
                            codexHome: homePath,
                            platformFamily: "unix",
                            platformOs: "linux",
                          }
                        : method === "account/read"
                          ? {
                              account: {
                                type: "chatgpt",
                                email,
                                planType: "pro",
                              },
                              requiresOpenaiAuth: true,
                            }
                          : method === "config/read"
                            ? { config: { model_provider: provider }, origins: {}, layers: null }
                            : method === "account/rateLimits/read"
                              ? {
                                  accountId,
                                  ordinaryUsageAllowed,
                                  rateLimits: {
                                    primary: {
                                      usedPercent: usage,
                                      windowDurationMins: 300,
                                      resetsAt: null,
                                    },
                                    secondary: {
                                      usedPercent: 2,
                                      windowDurationMins: 10080,
                                      resetsAt: null,
                                    },
                                    credits: null,
                                    planType: "pro",
                                  },
                                }
                              : { data: [], nextCursor: null };
                    return Queue.offer(
                      output,
                      new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`),
                    );
                  },
                  { discard: true },
                ),
              ),
              stdout: version
                ? Stream.encodeText(Stream.make("codex-cli 0.163.0\n"))
                : Stream.fromQueue(output),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        yield* Effect.gen(function* () {
          const instanceId = ProviderInstanceId.make("direct-codex-capacity");
          const instance = yield* CodexDriver.create({
            instanceId,
            displayName: undefined,
            enabled: true,
            environment: [],
            config: {
              ...CodexDriver.defaultConfig(),
              binaryPath: process.execPath,
              homePath,
              customModels: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }],
            },
          });
          const candidate = { instanceId, model: "gpt-6.1-sol" };
          const decision = yield* selectLaunchCandidate({
            candidates: [candidate],
            probe: () =>
              Effect.gen(function* () {
                const probeStartedAt = DateTime.toEpochMillis(yield* DateTime.now);
                const observed = yield* instance.probeDelegatedLaunch!(candidate.model);
                return observed ? { provider: observed, probeStartedAt } : undefined;
              }),
          });
          expect(decision.status).toBe("ready");
          if (decision.status === "ready")
            expect(decision.domains).toContain("codex:credential:backend-account");
          for (const exhaustedUsage of [100, 12]) {
            usage = exhaustedUsage;
            ordinaryUsageAllowed = false;
            const observedModels: string[] = [];
            const denied = yield* selectLaunchCandidate({
              candidates: [candidate, { instanceId, model: "gpt-6-astra" }],
              probe: (target) =>
                Effect.gen(function* () {
                  observedModels.push(target.model);
                  const probeStartedAt = DateTime.toEpochMillis(yield* DateTime.now);
                  const observed = yield* instance.probeDelegatedLaunch!(target.model);
                  usage = 1;
                  ordinaryUsageAllowed = true;
                  return observed ? { provider: observed, probeStartedAt } : undefined;
                }),
            });
            expect(denied.status).toBe("waiting");
            expect(observedModels).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
          }
          usage = 12;
          ordinaryUsageAllowed = false;
          const fallback = yield* selectLaunchCandidate({
            candidates: [candidate, { instanceId, model: "gpt-6-astra" }],
            probe: (target) =>
              Effect.gen(function* () {
                const probeStartedAt = DateTime.toEpochMillis(yield* DateTime.now);
                const observed = yield* instance.probeDelegatedLaunch!(target.model);
                usage = 1;
                ordinaryUsageAllowed = true;
                accountId = "independent-account";
                email = "independent@example.com";
                return observed ? { provider: observed, probeStartedAt } : undefined;
              }),
          });
          expect(fallback.status).toBe("ready");
          if (fallback.status === "ready") {
            expect(fallback.selection.model).toBe("gpt-6-astra");
            expect(fallback.domains).toContain("codex:credential:independent-account");
          }
          provider = "external-pool";
          expect(yield* instance.probeDelegatedLaunch!(candidate.model)).toBeUndefined();
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect(starts).toBe(0);
      }),
  );

  it.effect("exposes pool control only for the named launcher protocol", () =>
    Effect.gen(function* () {
      const spawned: Array<{
        command: string;
        args: ReadonlyArray<string>;
        account: string | undefined;
      }> = [];
      const recording = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command))
          spawned.push({
            command: command.command,
            args: command.args,
            account: command.options.env?.CODEX_T3_ACCOUNT,
          });
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const create = (config: Partial<ReturnType<typeof CodexDriver.defaultConfig>>) =>
        CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex_pool"),
          displayName: "Pool",
          enabled: true,
          environment: [{ name: "CODEX_T3_ACCOUNT", value: "pool", sensitive: false }],
          config: { ...CodexDriver.defaultConfig(), binaryPath: "/opt/fake/codex-t3", ...config },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recording));

      expect((yield* create({})).delegatedLaunchPool).toBeUndefined();
      const pooled = yield* create({ delegatedLaunchControl: "codex-t3-pool-v2" });
      expect(pooled.delegatedLaunchPool).toBeDefined();
      spawned.length = 0;
      // An unreachable launcher is unverified, never an exemption.
      expect(
        yield* pooled.delegatedLaunchPool!.prepare({
          runId: "run-driver",
          generation: 0,
          model: "gpt-6.1-sol",
          blockedQuotaDomains: [],
        }),
      ).toEqual({ status: "unverified" });
      expect(spawned).toEqual([
        { command: "/opt/fake/codex-t3", args: ["pool-control"], account: "pool" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("disconnect refreshes a restored managed account while its auth flow is idle", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("restored-managed-account");
      const credentials = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            credentials.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            credentials.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const json = yield* encodeCredentials({
          clientId: "oaiapp_test",
          accessToken: "dummy-owned-access",
          refreshToken: "dummy-refresh",
          expiresAt: Number.MAX_SAFE_INTEGER,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
          subject: "test-user",
          email: "account@example.test",
        });
        yield* store.set(new TextEncoder().encode(json));
        const executable = {
          executablePath: "/user/bin/codex",
          managedVersionDirectory: null,
          source: "local" as const,
          version: "0.156.1",
        };
        const installation = yield* CodexInstallation.CodexInstallation;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const sharedHome = NodePath.join(serverConfig.stateDir, "shared-codex-home");
        const launches: Array<
          Parameters<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>[0]
        > = [];

        let interruptedChecks = 0;
        let failAcquire = false;
        const startupChecksInterrupted = yield* Deferred.make<void>();
        const acquire = () =>
          Effect.suspend(() => {
            if (failAcquire)
              return Effect.fail(
                new CodexInstallation.CodexInstallationError({
                  operation: "acquire",
                  detail: "The fixture runtime is unavailable",
                }),
              );
            if (interruptedChecks === 2) return Effect.succeed(executable);
            interruptedChecks += 1;
            return (
              interruptedChecks === 2
                ? Deferred.succeed(startupChecksInterrupted, undefined)
                : Effect.void
            ).pipe(Effect.andThen(Effect.interrupt));
          });
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Restored account",
          enabled: true,
          environment: [{ name: "OPENAI_API_KEY", value: "ambient-key", sensitive: true }],
          config: { ...CodexDriver.defaultConfig(), setupMode: "managed", homePath: sharedHome },
        }).pipe(
          Effect.provideService(
            CodexAdapterV2.CodexAppServerClientFactory,
            CodexAdapterV2.CodexAppServerClientFactory.of({
              open: (launch) =>
                Effect.sync(() => launches.push(launch)).pipe(
                  Effect.andThen(Effect.die("The fixture stops after recording the launch")),
                ),
            }),
          ),
          Effect.provideService(
            CodexInstallation.CodexInstallation,
            CodexInstallation.CodexInstallation.of({
              ...installation,
              managedDirectory: "unused-managed-installation",
              resolve: () => Effect.succeed(executable),
              acquire,
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.fail(
                PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "The fixture app-server is unavailable",
                }),
              ),
            ),
          ),
        );
        const observedAccount = yield* Deferred.make<void>();
        const disconnected = yield* instance.snapshot.streamChanges.pipe(
          Stream.tap((provider) =>
            provider.auth.status === "authenticated"
              ? Deferred.succeed(observedAccount, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.filter((provider) => provider.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(startupChecksInterrupted);
        const restored = yield* instance.snapshot.refresh;
        expect(restored.auth.email).toBe("account@example.test");
        expect(restored.runtimePaths?.homePath).toBe(sharedHome);
        expect(restored.runtimePaths?.shadowHomePath).toContain(
          `providers/codex/${instanceId}/shadow`,
        );
        // The fixture app-server cannot start, so the workspace scan fails
        // instead of passing the machine snapshot off as the workspace's skills.
        const scan = yield* instance.snapshotForCwd!(serverConfig.stateDir).pipe(Effect.exit);
        expect(Exit.isFailure(scan)).toBe(true);
        // The account is still signed in, so a runtime that cannot start is a
        // failed scan too, not the machine snapshot's inventory.
        failAcquire = true;
        const runtimeScan = yield* instance.snapshotForCwd!(serverConfig.stateDir).pipe(
          Effect.exit,
        );
        failAcquire = false;
        expect(Exit.isFailure(runtimeScan)).toBe(true);
        yield* Deferred.await(observedAccount);

        const threadId = ThreadId.make("managed-account-thread");
        yield* instance.orchestrationAdapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("managed-account-session"),
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: serverConfig.stateDir,
            }),
          })
          .pipe(Effect.scoped, Effect.exit);
        expect(launches).toHaveLength(1);
        const launch = launches[0]!;
        expect(launch.settings.binaryPath).toBe(executable.executablePath);
        expect(launch.settings.launchArgs).toContain("openai_token_sharing");
        expect(launch.environment.ACCESS_TOKEN).toBe("dummy-owned-access");
        expect(launch.environment.OPENAI_API_KEY).toBeUndefined();
        expect(launch.environment.CODEX_HOME).toBe(launch.settings.homePath);
        const before = yield* instance.auth!.subscribe("test-owner").pipe(Stream.runHead);
        expect(Option.getOrThrow(before).phase).toBe("idle");
        yield* instance.auth!.logout(Effect.void);
        const after = Option.getOrThrow(yield* Fiber.join(disconnected));
        expect(after.auth.status).toBe("unauthenticated");
        expect(after.auth.email).toBeUndefined();
        expect(after.installed).toBe(true);
        expect(after.models).toEqual([]);
        expect(Option.isNone(yield* store.get)).toBe(true);
        // Signed out, there is no runtime to scan with, so the machine
        // snapshot's empty inventory stands instead of a failed scan.
        const signedOutScan = yield* instance.snapshotForCwd!(serverConfig.stateDir);
        expect(signedOutScan.skills).toEqual([]);
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              expect([
                "https://auth.openai.com/.well-known/openid-configuration",
                "https://auth.openai.com/revoke",
                "https://api.openai.com/v1/models",
              ]).toContain(request.url);
              if (request.url.endsWith("/models"))
                return HttpClientResponse.fromWeb(request, Response.json({ models: [] }));
              return HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/revoke")
                  ? new Response(null, { status: 200 })
                  : Response.json({
                      issuer: "https://auth.openai.com",
                      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                      jwks_uri: "https://auth.openai.com/jwks",
                      revocation_endpoint: "https://auth.openai.com/revoke",
                    }),
              );
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const shadowHome = NodePath.join(tempDir, "codex-shadow");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-shadow"),
          displayName: "Codex test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-installer-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-installer"),
          displayName: "Codex installer test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  for (const {} of ["direct", "wrapper"] as const) {
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== brewPath) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          probes.push(command.args);
          const stdout =
            command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-mise-shim"),
          displayName: "Codex shim test",
          enabled: false,
          environment: [{ name: "PATH", value: lookupPath, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: fixture.commandName,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, metadataSpawner));
        const capabilities = yield* instance.snapshot.resolveMaintenance();
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@openai/codex", "0.153.4"]]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining([
              "--prefix",
              yield* fs.realPath(npmPrefix),
              "@openai/codex@latest",
            ]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});
