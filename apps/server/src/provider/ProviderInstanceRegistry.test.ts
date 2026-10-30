import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ClaudeSettings,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  type ResolvedProviderInstanceEnvironment,
  ProviderInstanceId,
  SecretProviderId,
  type SecretReference,
} from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

// The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  idleCompaction: "default",
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistry.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* HostProcess.HomeDirectory;
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
    ),
    claudePath,
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistry — multi-instance codex slice", () => {
  const layerBaseDeps = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(
      Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
        endpoint: Effect.succeed("unused-private-pipe"),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
    ),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(Layer.mock(SecretResolver.SecretResolver)({})),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provide(PortScanner.layerTest),
    Layer.provideMerge(layerBase),
  );

  it.effect.each(["replacement", "removal"] as const)(
    "hides retired instances during reconcile (%s)",
    (scenario) =>
      Effect.gen(function* () {
        let closed = 0;
        const replacementStarted = yield* Deferred.make<void>();
        const releaseReplacement = yield* Deferred.make<void>();
        const driver: typeof CodexDriver = {
          ...CodexDriver,
          create: (input) =>
            Effect.gen(function* () {
              if (input.displayName === "Second") {
                yield* Deferred.succeed(replacementStarted, undefined);
                yield* Deferred.await(releaseReplacement);
              }
              const instance = yield* CodexDriver.create(input);
              yield* Effect.addFinalizer(() => Effect.sync(() => closed++));
              return instance;
            }),
        };
        const retiredId = ProviderInstanceId.make("retired");
        const siblingId = ProviderInstanceId.make("sibling");
        const nextId = scenario === "replacement" ? retiredId : ProviderInstanceId.make("new");
        const entry = {
          driver: CodexDriver.driverKind,
          enabled: false,
          config: makeCodexConfig({}),
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [retiredId]: entry, [siblingId]: entry },
        });
        const sibling = yield* registry.getInstance(siblingId);
        const reconcile = yield* mutator
          .reconcile({
            [siblingId]: entry,
            [nextId]: {
              ...entry,
              displayName: "Second",
              config: makeCodexConfig({ customModels: ["replacement-model"] }),
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(replacementStarted);
        expect(closed).toBe(1);
        expect(yield* registry.getInstance(retiredId)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([sibling]);
        yield* Deferred.succeed(releaseReplacement, undefined);
        yield* Fiber.join(reconcile);
        expect((yield* registry.getInstance(nextId))?.displayName).toBe("Second");
        expect(yield* registry.getInstance(siblingId)).toBe(sibling);
        expect(closed).toBe(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("runs Codex and Claude readiness probes from configured tilde paths", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();

      const codexId = ProviderInstanceId.make("codex_tilde");
      const claudeId = ProviderInstanceId.make("claude_tilde");
      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            {
              name: "T3_CODEX_COLLAB_SCRIPT",
              value: fixtures.codexScriptPath,
              sensitive: false,
            },
          ],
          config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv | ClaudeDriverEnv>({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();

      const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
        [codex!.snapshot.refresh, claude!.snapshot.refresh],
        { concurrency: "unbounded" },
      );
      expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
      expect(claudeSnapshot).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.219",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("runs Claude instance probes in the server state dir, not the server cwd", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const claudeId = ProviderInstanceId.make("claude_state_dir");
      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            // Packaged desktop starts in $HOME, where some claude wrappers refuse to run.
            environment: [{ name: "T3_CLAUDE_REQUIRED_CWD", value: stateDir, sensitive: false }],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);

      expect(yield* claude!.snapshot.refresh).toMatchObject({
        status: "ready",
        version: "2.1.219",
        auth: { status: "authenticated" },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("scopes Claude's one-probe fallback to the logged-in organization", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const accountConfigPath = path.join(fixtures.claudeHomePath, ".claude.json");
      yield* fs.writeFileString(
        accountConfigPath,
        JSON.stringify({ oauthAccount: { organizationUuid: "org-a" } }),
      );
      const claudeId = ProviderInstanceId.make("claude_probe_recovery");
      let probeCount = 0;
      let successfulProbeCount = 0;
      let failProbe = false;
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: () => {
              probeCount++;
              if (failProbe) return Promise.reject(new Error("initialization failed"));
              successfulProbeCount++;
              return Promise.resolve({
                commands: [
                  {
                    name: successfulProbeCount === 1 ? "last-good" : "recovered",
                    description: "",
                    argumentHint: "",
                  },
                ],
                account: {
                  email:
                    successfulProbeCount === 1 ? "account-a@example.com" : "account-b@example.com",
                  subscriptionType: "pro",
                  tokenSource: "oauth",
                },
              });
            },
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" },
              },
            }),
          }) as ReturnType<typeof ClaudeSdk.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);
      expect(claude).toBeDefined();

      const first = yield* claude!.snapshot.refresh;
      expect(first).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account-a@example.com", workspaceId: "org-a" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      });
      expect(first.usageLimits?.unavailable).toBeUndefined();
      expect(probeCount).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* fs.writeFileString(
        accountConfigPath,
        JSON.stringify({ oauthAccount: { organizationUuid: "org-b" } }),
      );
      yield* claude!.invalidateCaches ?? Effect.void;
      failProbe = true;
      const accountChangedFailure = yield* claude!.snapshot.refresh;

      expect(accountChangedFailure).toMatchObject({
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude Agent CLI failed while checking account status.",
      });
      expect(accountChangedFailure.checkedAt).not.toBe(first.checkedAt);
      expect(accountChangedFailure.usageLimits).toBeUndefined();
      expect(accountChangedFailure.slashCommands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      );
      const failedProbeCount = probeCount;
      expect(failedProbeCount).toBeGreaterThan(1);

      failProbe = false;
      const recovered = yield* claude!.snapshot.refresh;
      expect(recovered).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account-b@example.com", workspaceId: "org-b" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      });
      expect(recovered.usageLimits?.unavailable).toBeUndefined();
      const recoveredProbeCount = probeCount;
      expect(recoveredProbeCount).toBeGreaterThan(failedProbeCount);

      yield* TestClock.adjust("1 second");
      yield* claude!.invalidateCaches ?? Effect.void;
      failProbe = true;
      const sameAccountFailure = yield* claude!.snapshot.refresh;
      expect(sameAccountFailure).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account-b@example.com", workspaceId: "org-b" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      });
      expect(sameAccountFailure.usageLimits?.checkedAt).toBe(recovered.usageLimits?.checkedAt);
      expect(sameAccountFailure.usageLimits?.windows).toEqual(recovered.usageLimits?.windows);
      const sameAccountFailureProbeCount = probeCount;
      expect(sameAccountFailureProbeCount).toBeGreaterThan(recoveredProbeCount);

      const repeatedFailure = yield* claude!.snapshot.refresh;
      expect(repeatedFailure).toMatchObject({
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude Agent CLI failed while checking account status.",
      });
      expect(repeatedFailure.slashCommands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      );
      expect(probeCount).toBeGreaterThan(sameAccountFailureProbeCount);
    }).pipe(Effect.provide(layerTest)),
  );

  const redeemClaudeReset = (claim: { result: string; usageFailsAfterClaim: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = yield* makeTildeProviderFixtures();
      const marker = path.join(fixtures.claudeHomePath, "redeemed");
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"fake-token"}}',
      );
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".claude.json"),
        '{"oauthAccount":{"organizationUuid":"fake-org"}}',
      );
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/api/oauth/usage")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                cedar_ember: {
                  eligible: true,
                  next_grant_id: "grant_a",
                  grants: [{ id: "grant_a", resets_left: 1, usable_now: true }],
                },
              }),
            );
          }
          if (request.url.endsWith("/reset_rate_limits")) {
            yield* fs.writeFileString(marker, "redeemed").pipe(Effect.orDie);
            return HttpClientResponse.fromWeb(request, Response.json({ result: claim.result }));
          }
          return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
        }),
      );
      const instanceId = ProviderInstanceId.make("claude_reset");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            environment: [
              { name: "T3_CLAUDE_RESET_MARKER", value: marker, sensitive: false },
              ...(claim.usageFailsAfterClaim
                ? [{ name: "T3_CLAUDE_USAGE_FAILS_AFTER_CLAIM", value: "1", sensitive: false }]
                : []),
            ],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      const instance = yield* registry.getInstance(instanceId);
      expect(instance).toBeDefined();
      const before = yield* instance!.snapshot.refresh;
      expect(before.usageLimits?.windows[0]?.usedPercent).toBe(100);
      expect(before.usageLimits?.resetCredits?.nextCreditId).toBe("grant_a");
      const outcome = yield* instance!.consumeResetCredit!().pipe(Effect.result);
      return { outcome, after: yield* instance!.snapshot.getSnapshot };
    }).pipe(
      // macOS logins live in the Keychain, where resets are never read.
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(layerTest),
    );

  it.live.skipIf(windowsHost)("refreshes Claude usage after redeeming a reset", () =>
    Effect.gen(function* () {
      const { outcome, after } = yield* redeemClaudeReset({
        result: "reset",
        usageFailsAfterClaim: false,
      });
      expect(outcome).toMatchObject({ _tag: "Success", success: "reset" });
      expect(after.usageLimits?.windows[0]?.usedPercent).toBe(0);
    }),
  );

  it.live.skipIf(windowsHost)(
    "reports Claude's answer when a claim changed nothing and the re-probe fails",
    () =>
      Effect.gen(function* () {
        const { outcome } = yield* redeemClaudeReset({
          result: "already_used",
          usageFailsAfterClaim: true,
        });
        expect(outcome).toMatchObject({ _tag: "Success", success: "alreadyRedeemed" });
      }),
  );

  const makeClaudeCacheFixture = Effect.fnUntraced(function* (
    state: "ready" | "signed-out" | "usage-failed",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = yield* makeTildeProviderFixtures();
    const recovered = path.join(fixtures.claudeHomePath, "recovered");
    const probeLog = path.join(fixtures.claudeHomePath, "probes.log");
    const instanceId = ProviderInstanceId.make("claude_cache");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [ClaudeDriver],
      configMap: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [
            { name: "T3_CLAUDE_PROBE_LOG", value: probeLog, sensitive: false },
            ...(state === "ready"
              ? []
              : [
                  {
                    name:
                      state === "signed-out"
                        ? "T3_CLAUDE_LOGIN_MARKER"
                        : "T3_CLAUDE_USAGE_FAILS_UNTIL",
                    value: recovered,
                    sensitive: false,
                  },
                ]),
          ],
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      },
    });
    const instance = yield* registry.getInstance(instanceId);
    expect(instance).toBeDefined();
    return {
      refresh: instance!.snapshot.refresh,
      recover: fs.writeFileString(recovered, ""),
      probeLog: fs.readFileString(probeLog),
    };
  });

  for (const state of ["signed-out", "usage-failed"] as const) {
    it.effect.skipIf(windowsHost)(
      state === "signed-out"
        ? "shows Claude usage on the first refresh after signing back in"
        : "retries Claude usage on the first refresh after a failed usage read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeClaudeCacheFixture(state);
          const before = yield* fixture.refresh;
          if (state === "signed-out") {
            expect(before.auth.status).toBe("unauthenticated");
            expect(before.usageLimits).toBeUndefined();
          } else {
            expect(before.auth.status).toBe("authenticated");
            expect(before.usageLimits?.unavailable?.reason).toBe("probeFailed");
          }

          yield* fixture.recover;
          const after = yield* fixture.refresh;
          expect(after.auth.status).toBe("authenticated");
          expect(after.usageLimits?.unavailable).toBeUndefined();
          expect(after.usageLimits?.windows.map((window) => window.id)).toEqual(["five_hour"]);
        }).pipe(Effect.provide(layerTest)),
    );
  }

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(layerTest)),
  );
});

const DisabledByDefaultConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

describe("ProviderInstanceRegistry secret environment", () => {
  const driverKind = ProviderDriverKind.make("fake");
  const instanceId = ProviderInstanceId.make("fake_main");
  const secret: SecretReference = {
    provider: SecretProviderId.make("personal"),
    reference: "op://Private/OpenAI/credential",
  };

  function setup(
    initial: Record<string, string>,
    configSchema: AnyProviderDriver["configSchema"] = Schema.Unknown,
  ) {
    const vault = new Map(Object.entries(initial));
    const reads: Array<ReadonlyArray<string>> = [];
    const invalidated: Array<ReadonlyArray<string>> = [];
    const created: Array<ResolvedProviderInstanceEnvironment> = [];
    const driver: AnyProviderDriver = {
      driverKind,
      metadata: { displayName: "Fake" },
      configSchema,
      defaultConfig: () => ({}),
      create: (input) =>
        Effect.sync(() => {
          created.push(input.environment);
          return { instanceId: input.instanceId, enabled: input.enabled } as ProviderInstance;
        }),
    };
    const gate = Deferred.makeUnsafe<void>();
    const resolver = Layer.succeed(SecretResolver.SecretResolver, {
      read: (references) =>
        Deferred.await(gate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              reads.push(references.map((reference) => reference.reference));
              return references.map((reference) => vault.get(reference.reference));
            }),
          ),
        ),
      invalidate: (references = []) =>
        Effect.sync(() => {
          invalidated.push(references.map((reference) => reference.reference));
        }),
    });
    const configMap: ProviderInstanceConfigMap = {
      [instanceId]: {
        driver: driverKind,
        config: {},
        environment: [
          { name: "OPENAI_API_KEY", value: secret, sensitive: true },
          { name: "BASE_URL", value: "https://example.test", sensitive: false },
        ],
      },
    };
    const makeGated = makeProviderInstanceRegistry({ drivers: [driver], configMap }).pipe(
      Effect.provide(resolver),
    );
    // Secrets are read after startup, so wait for the change that applies them.
    const make = Effect.gen(function* () {
      const built = yield* makeGated;
      const changes = yield* built.registry.subscribeChanges;
      yield* Deferred.succeed(gate, undefined);
      yield* PubSub.take(changes);
      return built;
    });
    return { vault, reads, invalidated, created, make, makeGated, gate };
  }

  it.effect("starts an instance with the secret its environment points at", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry } = yield* fixture.make;

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(fixture.created).toEqual([
        [
          { name: "OPENAI_API_KEY", value: "sk-live", sensitive: true },
          { name: "BASE_URL", value: "https://example.test", sensitive: false },
        ],
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("marks an instance unavailable and names the variable it could not read", () => {
    const fixture = setup({});
    return Effect.gen(function* () {
      const { registry } = yield* fixture.make;

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect(fixture.created).toEqual([]);
      const [unavailable] = yield* registry.listUnavailable;
      expect(unavailable?.instanceId).toBe(instanceId);
      expect(unavailable?.unavailableReason).toContain("OPENAI_API_KEY");
    }).pipe(Effect.scoped);
  });

  it.effect("does not read the secrets of an instance its config decodes as disabled", () => {
    const fixture = setup({ [secret.reference]: "sk-live" }, DisabledByDefaultConfig);
    return Effect.gen(function* () {
      const { mutator } = yield* fixture.makeGated;
      yield* mutator.reloadSecrets();

      expect(fixture.reads).toEqual([]);
      expect(fixture.invalidated).toEqual([]);
      expect(fixture.created).toHaveLength(1);
    }).pipe(Effect.scoped);
  });

  it.effect("re-reads secrets on reload and rebuilds only when they changed", () => {
    const fixture = setup({});
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;

      fixture.vault.set(secret.reference, "sk-live");
      yield* mutator.reloadSecrets();
      expect(fixture.invalidated).toEqual([[secret.reference]]);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);

      yield* mutator.reloadSecrets(instanceId);
      expect(fixture.created).toHaveLength(1);

      fixture.vault.set(secret.reference, "sk-rotated");
      yield* mutator.reloadSecrets(instanceId);
      expect(fixture.created.map((environment) => environment[0]?.value)).toEqual([
        "sk-live",
        "sk-rotated",
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("keeps a working instance live when a reload cannot read its secret", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;

      fixture.vault.delete(secret.reference);
      yield* mutator.reloadSecrets();

      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);
      expect(fixture.created).toHaveLength(1);
    }).pipe(Effect.scoped);
  });

  it.effect("starts without waiting for secrets to be read", () => {
    const fixture = setup({ [secret.reference]: "sk-live" });
    return Effect.gen(function* () {
      const { registry } = yield* fixture.makeGated;
      const changes = yield* registry.subscribeChanges;

      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      const [pending] = yield* registry.listUnavailable;
      expect(pending?.unavailableReason).toBe("Reading secrets…");

      yield* Deferred.succeed(fixture.gate, undefined);
      yield* PubSub.take(changes);
      expect(yield* registry.getInstance(instanceId)).toBeDefined();
      expect(yield* registry.listUnavailable).toEqual([]);
    }).pipe(Effect.scoped);
  });
});
