import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
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
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { GrokSettings } from "@t3tools/provider-grok/settings";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { CursorDriver, type CursorDriverEnv } from "@t3tools/provider-cursor/server";
import { GrokDriver, type GrokDriverEnv } from "@t3tools/provider-grok/server";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as ModelManifest from "./ModelManifest.ts";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

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
  reportHostPowerState: () => Effect.void,
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
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
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
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
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
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
    ),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
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
    Layer.provideMerge(layerBase),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.orchestrationAdapter).not.toBe(work!.orchestrationAdapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      const path = yield* Path.Path;
      expect(personalSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex_personal")}`,
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex")}`,
      );

      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
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

  it.live("reports Codex's answer when a redemption changed nothing", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* makeTildeProviderFixtures();
      yield* fileSystem.writeFileString(
        fixtures.codexScriptPath,
        JSON.stringify({
          rootThreadId: "probe-thread",
          notifications: [],
          account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
          failRateLimitsRead: true,
          resetCreditOutcome: "alreadyRedeemed",
        }),
      );
      const codexId = ProviderInstanceId.make("codex_reset");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            environment: [
              { name: "T3_CODEX_COLLAB_SCRIPT", value: fixtures.codexScriptPath, sensitive: false },
            ],
            config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
          },
        },
      });
      const codex = yield* registry.getInstance(codexId);
      expect(codex).toBeDefined();
      yield* codex!.snapshot.refresh;
      expect(yield* codex!.consumeResetCredit!()).toBe("alreadyRedeemed");
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
            // Packaged desktop builds start the server in $HOME, where some
            // `claude` wrappers refuse to run.
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

describe("ProviderInstanceRegistry — all drivers slice", () => {
  const layerInfra = OpenCodeRuntime.layer.pipe(
    Layer.provide(OpenCodeServerLedger.layerTest),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  );
  const layerBaseDeps = AntigravityInstallation.AntigravityInstallation.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "provider-instance-registry-all-drivers-test",
      }),
    ),
    Layer.provideMerge(layerInfra),
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
    Layer.provideMerge(layerBase),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<
        CodexDriverEnv | ClaudeDriverEnv | CursorDriverEnv | GrokDriverEnv | OpenCodeDriverEnv
      >({
        drivers: [CodexDriver, ClaudeDriver, CursorDriver, GrokDriver, OpenCodeDriver],
        configMap,
      });

      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(5);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, openCodeId].toSorted(),
      );

      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      const openCode = yield* registry.getInstance(openCodeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");
      expect(openCode?.displayName).toBe("OpenCode");

      const adapters = [
        codex!.orchestrationAdapter,
        claude!.orchestrationAdapter,
        cursor!.orchestrationAdapter,
        grok!.orchestrationAdapter,
        openCode!.orchestrationAdapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
        openCode!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
        openCode!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe(
        `codex:home:${(yield* Path.Path).resolve("/home/julius/.codex")}`,
      );

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe(
        `claude:home:${(yield* Path.Path).resolve("/home/julius/.claude-work")}`,
      );

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );
    }).pipe(Effect.provide(layerTest)),
  );
});
