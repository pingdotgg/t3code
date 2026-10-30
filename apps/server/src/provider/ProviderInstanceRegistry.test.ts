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
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
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

  const resetCreditResponse = (count: number) => ({
    cedar_ember: {
      eligible: true,
      next_grant_id: count > 0 ? "grant_a" : null,
      grants: [{ id: "grant_a", resets_left: count, usable_now: true }],
    },
  });

  const awaitClaudeReady = Effect.fn(function* (instance: ProviderInstance) {
    const ready = yield* instance.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.installed),
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    );
    if (!(yield* instance.snapshot.getSnapshot).installed) yield* Fiber.join(ready);
    yield* Fiber.interrupt(ready);
  });

  const makeClaudeResetFixtures = Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const fixtures = yield* makeTildeProviderFixtures();
    const writeLogin = Effect.fn(function* (
      home: string,
      account: string,
      organization = "org-a",
      token = `synthetic-${account}`,
    ) {
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(
        path.join(home, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      );
      yield* fs.writeFileString(
        path.join(home, ".claude.json"),
        JSON.stringify({
          oauthAccount: {
            accountUuid: account,
            organizationUuid: organization,
            emailAddress: `${account}@example.com`,
          },
        }),
      );
    });
    yield* writeLogin(fixtures.claudeHomePath, "account-a");
    const start = Effect.fn(function* (
      client: HttpClient.HttpClient,
      homes: ReadonlyArray<string> = [fixtures.claudeHomePath],
    ) {
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap: Object.fromEntries(
          homes.map((homePath, index) => [
            ProviderInstanceId.make(`claude_reset_${index}`),
            {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: makeClaudeConfig({
                enabled: true,
                binaryPath: fixtures.claudeBinaryPath,
                homePath,
              }),
            },
          ]),
        ),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        // These tests drive refreshes explicitly, including across virtual-clock intervals.
        Effect.provideService(ProviderHost.ProviderHost, {
          ...host,
          shouldRunBackgroundWork: () => Effect.succeed(false),
        }),
      );
      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(homes.length);
      return instances;
    });
    return { home: fixtures.claudeHomePath, writeLogin, start };
  });

  it.effect.skipIf(windowsHost)(
    "throttles Claude reset reads across failures and cancellation, and resets backoff on an empty success",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeClaudeResetFixtures();
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        let delayNextRead = false;
        let requests = 0;
        let status = 200;
        let body: unknown = resetCreditResponse(3);
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (!request.url.endsWith("/api/oauth/usage")) {
              return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
            }
            requests++;
            if (delayNextRead) {
              delayNextRead = false;
              expect(request.method).toBe("GET");
              yield* Deferred.succeed(readStarted, undefined);
              yield* Deferred.await(releaseRead);
            }
            return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
          }),
        );
        const [instance] = yield* fixture.start(client);
        yield* awaitClaudeReady(instance!);
        const first = yield* instance!.snapshot.refresh;
        expect(first.status).toBe("ready");
        expect(first.usageLimits?.resetCredits?.availableCount).toBe(3);
        expect.soft(requests).toBe(1);

        const minute = 60_000;
        for (const step of [
          { after: 10 * minute - 1, status: 429, calls: 1, count: 3 },
          { after: 1, status: 429, calls: 2, count: 3 },
          { after: 20 * minute - 1, status: 429, calls: 2, count: 3 },
          { after: 1, status: 429, calls: 3, count: 3 },
          { after: 40 * minute - 1, status: 429, calls: 3, count: 3 },
          { after: 1, status: 429, calls: 4, count: 3 },
          { after: 60 * minute - 1, status: 429, calls: 4, count: 3 },
          { after: 1, status: 429, calls: 5, count: 3 },
          { after: 60 * minute, status: 200, calls: 6, count: undefined },
          { after: 10 * minute - 1, status: 200, calls: 6, count: undefined },
          { after: 1, status: 200, calls: 7, count: 5 },
        ]) {
          status = step.status;
          body = step.calls === 6 ? { cedar_ember: { eligible: false } } : resetCreditResponse(5);
          yield* TestClock.adjust(step.after);
          const snapshot = yield* instance!.snapshot.refresh;
          expect.soft(snapshot.usageLimits?.resetCredits?.availableCount).toBe(step.count);
          expect.soft(requests).toBe(step.calls);
        }

        yield* TestClock.adjust("10 minutes");
        body = resetCreditResponse(1);
        delayNextRead = true;
        const reading = yield* instance!.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(readStarted);
        expect(requests).toBe(8);
        yield* Fiber.interrupt(reading);
        yield* Deferred.succeed(releaseRead, undefined);

        // A dispatched GET spends the account's budget even if its caller cancels the refresh.
        for (const step of [
          { after: 0, calls: 8, count: 5 },
          { after: 10 * minute - 1, calls: 8, count: 5 },
          { after: 1, calls: 9, count: 1 },
        ]) {
          yield* TestClock.adjust(step.after);
          const snapshot = yield* instance!.snapshot.refresh;
          expect.soft(snapshot.usageLimits?.resetCredits?.availableCount).toBe(step.count);
          expect.soft(requests).toBe(step.calls);
        }
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
  );

  it.effect.skipIf(windowsHost)(
    "drops Claude reset credits when the account changes or its login becomes unreadable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeClaudeResetFixtures();
        let requests = 0;
        let status = 200;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (!request.url.endsWith("/api/oauth/usage")) {
              return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
            }
            requests++;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(resetCreditResponse(3), { status }),
            );
          }),
        );
        const [instance] = yield* fixture.start(client);
        yield* awaitClaudeReady(instance!);
        expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits?.availableCount).toBe(
          3,
        );
        const beforeSwitch = requests;
        yield* fixture.writeLogin(fixture.home, "account-b");
        status = 429;
        expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits).toBeUndefined();
        expect(requests).toBe(beforeSwitch + 1);

        status = 200;
        yield* TestClock.adjust("20 minutes");
        expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits?.availableCount).toBe(
          3,
        );
        const beforeSignout = requests;
        const credentialsPath = path.join(fixture.home, ".credentials.json");
        yield* fs.writeFileString(credentialsPath, "unreadable-json");
        expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits).toBeUndefined();
        yield* fs.remove(credentialsPath);
        expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits).toBeUndefined();
        expect(requests).toBe(beforeSignout);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
  );

  it.effect.skipIf(windowsHost)(
    "shares Claude reset reads across instances and homes without blocking another account",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeClaudeResetFixtures();
        const aliasHome = `${fixture.home}-alias`;
        const otherHome = `${fixture.home}-other`;
        yield* fixture.writeLogin(aliasHome, "account-a", "org-a", "synthetic-rotated");
        yield* fixture.writeLogin(otherHome, "account-a", "org-b", "synthetic-other-org");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const otherAccountRead = yield* Deferred.make<void>();
        let sharedRequests = 0;
        let otherRequests = 0;
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (!request.url.endsWith("/api/oauth/usage")) {
              return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
            }
            const otherAccount = request.headers.authorization === "Bearer synthetic-other-org";
            if (otherAccount) {
              otherRequests++;
              yield* Deferred.succeed(otherAccountRead, undefined);
            } else {
              sharedRequests++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
            }
            return HttpClientResponse.fromWeb(
              request,
              Response.json(resetCreditResponse(otherAccount ? 1 : 3)),
            );
          }),
        );
        const instances = yield* fixture.start(client, [
          fixture.home,
          fixture.home,
          aliasHome,
          otherHome,
        ]);
        yield* Deferred.await(started);
        yield* Deferred.await(otherAccountRead);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(instances, awaitClaudeReady, { concurrency: "unbounded" });
        const snapshots = yield* Effect.forEach(
          instances,
          (instance) => instance.snapshot.refresh,
          { concurrency: "unbounded" },
        );
        expect(
          snapshots.map((snapshot) => snapshot.usageLimits?.resetCredits?.availableCount),
        ).toEqual([3, 3, 3, 1]);
        expect.soft(sharedRequests).toBe(1);
        expect.soft(otherRequests).toBe(1);

        yield* fixture.writeLogin(fixture.home, "account-a", "org-a", "synthetic-rotated-again");
        expect(
          (yield* instances[0]!.snapshot.refresh).usageLimits?.resetCredits?.availableCount,
        ).toBe(3);
        expect.soft(sharedRequests).toBe(1);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
  );

  it.effect.skipIf(windowsHost)(
    "refreshes shared Claude credits after redeeming while an older read is in flight",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeClaudeResetFixtures();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let count = 3;
        let delayNextRead = false;
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (request.url.endsWith("/api/oauth/usage")) {
              const body = resetCreditResponse(count);
              if (delayNextRead) {
                delayNextRead = false;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return HttpClientResponse.fromWeb(request, Response.json(body));
            }
            if (request.url.endsWith("/reset_rate_limits")) {
              count = 0;
              return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
            }
            return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
          }),
        );
        const [redeemer, observer] = yield* fixture.start(client, [fixture.home, fixture.home]);
        yield* Effect.all([awaitClaudeReady(redeemer!), awaitClaudeReady(observer!)], {
          concurrency: "unbounded",
        });
        expect(
          (yield* redeemer!.snapshot.getSnapshot).usageLimits?.resetCredits?.availableCount,
        ).toBe(3);
        yield* TestClock.adjust("10 minutes");
        delayNextRead = true;
        const reading = yield* observer!.snapshot.refresh.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const claiming = yield* redeemer!.consumeResetCredit!().pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        // A coordinator may serialize the claim behind this read or discard its old answer.
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(reading);
        expect(yield* Fiber.join(claiming)).toBe("reset");
        expect((yield* redeemer!.snapshot.getSnapshot).usageLimits?.resetCredits).toEqual({
          availableCount: 0,
        });
        expect((yield* observer!.snapshot.refresh).usageLimits?.resetCredits).toEqual({
          availableCount: 0,
        });
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
  );

  it.effect.skipIf(windowsHost)(
    "uses the current Claude token after a refresh waits for an active claim",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeClaudeResetFixtures();
        const claimStarted = yield* Deferred.make<void>();
        const releaseClaim = yield* Deferred.make<void>();
        const tokenCaptured = yield* Deferred.make<string>();
        let watchingCredentials = false;
        let credentialReads = 0;
        let rotated = false;
        const usageTokens: Array<string | undefined> = [];
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (request.url.endsWith("/api/oauth/usage")) {
              usageTokens.push(request.headers.authorization);
              const revoked =
                rotated && request.headers.authorization === "Bearer synthetic-account-a";
              return HttpClientResponse.fromWeb(
                request,
                Response.json(resetCreditResponse(rotated ? 2 : 3), {
                  status: revoked ? 401 : 200,
                }),
              );
            }
            if (request.url.endsWith("/reset_rate_limits")) {
              yield* Deferred.succeed(claimStarted, undefined);
              yield* Deferred.await(releaseClaim);
              return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
            }
            return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
          }),
        );
        const [redeemer, observer] = yield* fixture
          .start(client, [fixture.home, fixture.home])
          .pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                fs.readFileString(file, encoding).pipe(
                  Effect.tap((contents) => {
                    if (
                      !watchingCredentials ||
                      file !== path.join(fixture.home, ".credentials.json")
                    )
                      return Effect.void;
                    // The refresh checks identity first, then captures the token for its credit read.
                    credentialReads++;
                    return credentialReads === 2
                      ? Deferred.succeed(tokenCaptured, contents)
                      : Effect.void;
                  }),
                ),
            }),
          );
        yield* Effect.all([awaitClaudeReady(redeemer!), awaitClaudeReady(observer!)], {
          concurrency: "unbounded",
        });
        expect((yield* observer!.snapshot.refresh).usageLimits?.resetCredits?.availableCount).toBe(
          3,
        );
        yield* TestClock.adjust("10 minutes");
        const claiming = yield* redeemer!.consumeResetCredit!().pipe(Effect.forkChild);
        yield* Deferred.await(claimStarted);
        usageTokens.length = 0;
        watchingCredentials = true;
        const reading = yield* observer!.snapshot.refresh.pipe(Effect.forkChild);
        expect(yield* Deferred.await(tokenCaptured)).toContain("synthetic-account-a");
        watchingCredentials = false;
        expect(usageTokens).toEqual([]);
        yield* fixture.writeLogin(fixture.home, "account-a", "org-a", "synthetic-rotated");
        rotated = true;
        yield* Deferred.succeed(releaseClaim, undefined);
        yield* Fiber.join(reading);
        expect(yield* Fiber.join(claiming)).toBe("reset");

        expect.soft(usageTokens).toEqual(["Bearer synthetic-rotated"]);
        // A revoked request must not make either instance wait through the failure backoff.
        for (const instance of [observer!, redeemer!]) {
          expect
            .soft((yield* instance.snapshot.refresh).usageLimits?.resetCredits?.availableCount)
            .toBe(2);
        }
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
  );

  it.effect.skipIf(windowsHost)("ages all cached Claude grants without another usage request", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClaudeResetFixtures();
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (!request.url.endsWith("/api/oauth/usage")) {
            return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
          }
          requests++;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: {
                eligible: true,
                next_grant_id: "grant_a",
                grants: [
                  {
                    id: "grant_a",
                    resets_left: 2,
                    usable_now: true,
                    ends_at: "1970-01-01T00:05:00Z",
                  },
                  {
                    id: "grant_b",
                    resets_left: 3,
                    usable_now: true,
                    ends_at: "1970-01-01T00:02:00Z",
                  },
                ],
              },
            }),
          );
        }),
      );
      const [instance] = yield* fixture.start(client);
      yield* awaitClaudeReady(instance!);
      expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits?.availableCount).toBe(5);
      yield* TestClock.adjust("2 minutes");
      expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits?.availableCount).toBe(2);
      yield* TestClock.adjust("3 minutes");
      expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits).toEqual({
        availableCount: 0,
      });
      expect(requests).toBe(1);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
  );

  it.effect.skipIf(windowsHost)(
    "keeps unconfirmed Claude claims through failed and empty usage reads",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeClaudeResetFixtures();
        const claims: Array<string> = [];
        let count = 3;
        let usageStatus = 200;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.url.endsWith("/api/oauth/usage")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json(resetCreditResponse(count), { status: usageStatus }),
              );
            }
            if (request.url.endsWith("/reset_rate_limits")) {
              claims.push(
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "",
              );
              count = 0;
              usageStatus = claims.length === 1 ? 429 : 200;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ result: claims.length < 3 ? "unavailable" : "reset" }),
              );
            }
            return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
          }),
        );
        const [instance] = yield* fixture.start(client);
        yield* awaitClaudeReady(instance!);
        expect((yield* instance!.consumeResetCredit!().pipe(Effect.result))._tag).toBe("Failure");
        expect
          .soft((yield* instance!.snapshot.refresh).usageLimits?.resetCredits?.availableCount)
          .toBe(3);

        yield* TestClock.adjust("1 second");
        expect((yield* instance!.consumeResetCredit!().pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* instance!.snapshot.refresh).usageLimits?.resetCredits).toEqual({
          availableCount: 0,
        });
        yield* TestClock.adjust("1 second");
        expect(yield* instance!.consumeResetCredit!()).toBe("reset");
        expect(claims).toHaveLength(3);
        expect(claims[0]).toContain('"grant_id":"grant_a"');
        expect(claims[1]).toBe(claims[0]);
        expect(claims[2]).toBe(claims[0]);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(layerTest)),
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
              Response.json(
                resetCreditResponse((yield* fs.exists(marker).pipe(Effect.orDie)) ? 0 : 1),
              ),
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
      expect(after.usageLimits?.resetCredits).toEqual({ availableCount: 0 });
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
