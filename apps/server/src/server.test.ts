import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  AuthAccessTokenType,
  AuthStandardClientScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DpopFailureReason,
  EnvironmentId,
  EventId,
  GitCommandError,
  KeybindingRule,
  MessageId,
  ExternalLauncherCommandNotFoundError,
  OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  TerminalNotRunningError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  type PreviewEvent,
  ProjectId,
  type ProviderAuthState,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  ProviderSetupError,
  ResolvedKeybindingRule,
  ThreadId,
  TurnId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { RELAY_HEALTH_REQUEST_TYP, RELAY_MINT_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vite-plus/test";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const decodeTransferThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);
const decodeTransferShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationShellSnapshot),
);

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ServerConfig from "./config.ts";
import { HTTP_ROUTER_CONFIG, makeRoutesLayer } from "./server.ts";
import {
  isThreadDetailEvent,
  resolveAvailableEditorsForConfig,
  resolveFileManagerRevealKindForConfig,
} from "./ws.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationListenerCallbackError,
  OrchestrationThreadSettleBlockedError,
} from "./orchestration/Errors.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import {
  AntigravityInstallation,
  AntigravityInstallationError,
} from "./provider/AntigravityInstallation.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import { ProviderAdapterRequestError } from "./provider/Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./provider/providerMaintenance.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriver from "./vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as Data from "effect/Data";

import { makeOrchestrationIntegrationHarness } from "../integration/OrchestrationEngineHarness.integration.ts";
import {
  measureHttpGet,
  openMeasuredWsClient,
  transferDelta,
} from "../integration/NetworkTransferMeasurement.integration.ts";
import { makeSqlStatementCounter } from "../integration/SqlStatementCounter.integration.ts";
import {
  awaitSubscriptionSynchronized,
  collectQueueUntil,
  expectedMeasuredAssistantText,
  queueMeasuredTransferTurn,
  seedTransferBudgetHistory,
  subscribeShellItems,
  subscribeThreadItems,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_MEASURED_TURN_CREATED_AT,
  TRANSFER_MEASURED_TURN_INDEX,
  TRANSFER_THREAD_ID,
  transferModelSelection,
  waitForTurnQuiesced,
} from "../integration/TransferBudgetScenario.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  type TransferBudgetRun,
  transferBudgetViolations,
} from "../integration/TransferBudgetReport.integration.ts";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const providerSetupInstanceId = ProviderInstanceId.make("antigravity-custom-profile");
const providerSetupDriver = ProviderDriverKind.make("antigravity");
const providerSetupInstallState: ProviderInstallState = {
  driver: providerSetupDriver,
  operationId: "install-operation",
  phase: "downloading",
  downloadedBytes: 128,
  totalBytes: 256,
  version: "test-release",
  installedVersion: null,
  canRemove: false,
  message: null,
};
const providerSetupAuthState: ProviderAuthState = {
  instanceId: providerSetupInstanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const providerSetupInstance: ProviderInstance = {
  instanceId: providerSetupInstanceId,
  driverKind: providerSetupDriver,
  enabled: false,
  displayName: "Google account",
  continuationIdentity: {
    driverKind: providerSetupDriver,
    continuationKey: providerSetupInstanceId,
  },
  get adapter(): never {
    throw new Error("Provider setup must not start a chat session.");
  },
  get snapshot(): never {
    throw new Error("Installation routing must not probe the provider.");
  },
  get textGeneration(): never {
    throw new Error("Provider setup must not generate text.");
  },
};

const makeLiveToolActivityEvent = (
  sequence: number,
  kind: "tool.updated" | "tool.completed" = "tool.updated",
  options: {
    readonly toolCallId?: string;
    readonly title?: string;
    readonly path?: string;
  } = {},
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => {
  const { toolCallId = "call-edit", title = "Editing app.ts", path = "src/app.ts" } = options;
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`activity-${sequence}`),
    tone: "tool",
    kind,
    summary: title,
    payload: {
      itemType: "file_change",
      title,
      data: { toolCallId, path },
    },
    turnId: TurnId.make("turn-edit"),
    createdAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    sequence,
    eventId: EventId.make(`event-tool-${sequence}`),
    aggregateKind: "thread",
    aggregateId: defaultThreadId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: { threadId: defaultThreadId, activity },
  };
};
const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const makeDefaultOrchestrationReadModel = () => {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: "Default Thread",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
};

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const makeAuthTestLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
        getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
      }),
    ),
  );

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    // The exporter's batch fiber is forked while the layer builds and ticks on
    // a wall-clock interval, so the whole tracer runs on the live clock.
    yield* Layer.build(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    ).pipe(
      Effect.flatMap((tracing) =>
        Effect.void.pipe(Effect.withSpan(spanName), Effect.provideContext(tracing)),
      ),
      TestClock.withLive,
    );

    const request = yield* Effect.raceFirst(
      Effect.promise(() => collector.firstRequest).pipe(Effect.orDie),
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.andThen(Effect.die(new Error("Timed out waiting for OTLP trace export"))),
      ),
    );
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  onPairingChangesSubscribed?: Effect.Effect<void>;
  config?: Partial<ServerConfig.ServerConfig["Service"]>;
  layers?: {
    keybindings?: Partial<Keybindings.Keybindings["Service"]>;
    environmentTheme?: Partial<EnvironmentTheme.EnvironmentThemeService["Service"]>;
    providerRegistry?: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
    providerService?: Partial<ProviderService.ProviderService["Service"]>;
    providerAuth?: Partial<ProviderAuthService["Service"]>;
    providerInstanceRegistry?: Partial<ProviderInstanceRegistry["Service"]>;
    antigravityInstallation?: Partial<AntigravityInstallation["Service"]>;
    serverSettings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher["Service"]>;
    vcsDriver?: Partial<VcsDriver.VcsDriver["Service"]>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry["Service"]>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
    gitManager?: Partial<GitManager.GitManager["Service"]>;
    sourceControlRepositoryService?: Partial<
      SourceControlRepositoryService.SourceControlRepositoryService["Service"]
    >;
    reviewService?: Partial<ReviewService.ReviewService["Service"]>;
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>;
    projectSetupScriptRunner?: Partial<
      ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
    >;
    terminalManager?: Partial<TerminalManager.TerminalManager["Service"]>;
    orchestrationEngine?: Partial<OrchestrationEngine.OrchestrationEngineService["Service"]>;
    threadDeletionReactor?: Partial<ThreadDeletionReactor["Service"]>;
    analyticsService?: Partial<AnalyticsService.AnalyticsService["Service"]>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]>;
    checkpointDiffQuery?: Partial<CheckpointDiffQuery.CheckpointDiffQuery["Service"]>;
    browserTraceCollector?: Partial<BrowserTraceCollector.BrowserTraceCollector["Service"]>;
    serverLifecycleEvents?: Partial<ServerLifecycleEvents.ServerLifecycleEvents["Service"]>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartup.ServerRuntimeStartup["Service"]>;
    serverEnvironment?: Partial<ServerEnvironment.ServerEnvironment["Service"]>;
    repositoryIdentityResolver?: Partial<
      RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]
    >;
    cloudManagedEndpointRuntime?: Partial<
      CloudManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]
    >;
    relayClient?: Partial<RelayClient.RelayClient["Service"]>;
    cloudCliTokenManager?: Partial<CloudCliTokenManager.CloudCliTokenManager["Service"]>;
    nativeTelemetryClient?: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;
    desktopTelemetryReceiver?: Partial<
      DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]
    >;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...options?.config,
    };
    const layerConfig = ServerConfig.layer(config);
    const defaultVcsDriver: VcsDriver.VcsDriver["Service"] = {
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    };
    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.flatMap((repository) =>
            repository
              ? Effect.succeed(repository)
              : defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                  Effect.map((isInsideWorkTree) =>
                    isInsideWorkTree
                      ? {
                          kind: "git" as const,
                          rootPath: input.cwd,
                          metadataPath: null,
                          freshness: {
                            source: "live-local" as const,
                            observedAt: TEST_EPOCH,
                            expiresAt: Option.none(),
                          },
                        }
                      : null,
                  ),
                ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    });
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    });
    const gitManagerLayer = Layer.mock(GitManager.GitManager)({
      ...options?.layers?.gitManager,
    });
    const workspaceEntriesLayer = WorkspaceEntries.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provideMerge(vcsDriverRegistryLayer),
    );
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(workspaceEntriesLayer),
      ),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer,
    );
    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
      Layer.provideMerge(gitManagerLayer),
    );
    const vcsProvisioningLayer = VcsProvisioningService.layer.pipe(
      Layer.provide(vcsDriverRegistryLayer),
    );
    const reviewLayer = options?.layers?.reviewService
      ? Layer.mock(ReviewService.ReviewService)({
          ...options.layers.reviewService,
        })
      : ReviewService.layer.pipe(
          Layer.provideMerge(gitVcsDriverLayer),
          Layer.provide(vcsDriverRegistryLayer),
        );
    const vcsStatusBroadcasterLayer = options?.layers?.vcsStatusBroadcaster
      ? Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          ...options.layers.vcsStatusBroadcaster,
        })
      : VcsStatusBroadcaster.layer.pipe(Layer.provide(gitWorkflowLayer));
    const resourceTelemetryLayer = ResourceTelemetry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NativeTelemetryClient.layerTest(options?.layers?.nativeTelemetryClient),
          DesktopTelemetryReceiver.layerTest(options?.layers?.desktopTelemetryReceiver),
          ResourceAttribution.layer,
        ),
      ),
    );
    const serviceLauncherClientLayer = ServiceLauncherClient.layer.pipe(
      Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
    );

    const servedRoutesLayer = HttpRouter.serve(
      makeRoutesLayer.pipe(Layer.provide(serviceLauncherClientLayer)),
      {
        disableListenLog: true,
        disableLogger: true,
        routerConfig: HTTP_ROUTER_CONFIG,
      },
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Keybindings.Keybindings)({
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
            ...options?.layers?.keybindings,
          }),
          Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
            current: Effect.succeed([]),
            streamChanges: Stream.empty,
            ...options?.layers?.environmentTheme,
          }),
          Layer.mock(UsageLimitSources.UsageLimitSources)({
            current: Effect.succeed([]),
            streamChanges: Stream.empty,
            refresh: Effect.void,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
            refresh: () => Effect.succeed([]),
            refreshInstance: () => Effect.succeed([]),
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
              ),
            setProviderMaintenanceActionState: () => Effect.succeed([]),
            streamChanges: Stream.empty,
            ...options?.layers?.providerRegistry,
          }),
          Layer.mock(ProviderService.ProviderService)({
            uploadFeedback: () => Effect.die("Provider feedback is not stubbed in this test"),
            ...options?.layers?.providerService,
          }),
          Layer.mock(ProviderAuthService)({
            ...options?.layers?.providerAuth,
          }),
          Layer.mock(ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(undefined),
            listInstances: Effect.succeed([]),
            ...options?.layers?.providerInstanceRegistry,
          }),
          Layer.mock(AntigravityInstallation)({
            managedDirectory: "unused-test-antigravity-runtime",
            ...options?.layers?.antigravityInstallation,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ExternalLauncher.ExternalLauncher)({
            resolveAvailableEditors: () => Effect.succeed([]),
            resolveFileManagerRevealKind: () => Effect.sync((): undefined => undefined),
            ...options?.layers?.externalLauncher,
          }),
          Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
            resolveTargets: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
          read: Effect.succeed({
            serverPid: process.pid,
            readAt: TEST_EPOCH,
            processCount: 0,
            totalRssBytes: 0,
            totalCpuPercent: 0,
            processes: [],
            error: Option.none(),
          }),
          signal: (input) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: true,
              message: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: (input) =>
            Effect.succeed({
              readAt: TEST_EPOCH,
              windowMs: input.windowMs,
              bucketMs: input.bucketMs,
              sampleIntervalMs: 5_000,
              retainedSampleCount: 0,
              totalCpuSecondsApprox: 0,
              buckets: [],
              topProcesses: [],
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(TraceDiagnostics.TraceDiagnostics)({
          read: () =>
            Effect.succeed({
              traceFilePath: "",
              scannedFilePaths: [],
              readAt: TEST_EPOCH,
              recordCount: 0,
              parseErrorCount: 0,
              firstSpanAt: Option.none(),
              lastSpanAt: Option.none(),
              failureCount: 0,
              interruptionCount: 0,
              slowSpanThresholdMs: 1_000,
              slowSpanCount: 0,
              logLevelCounts: {},
              topSpansByCount: [],
              slowestSpans: [],
              commonFailures: [],
              latestFailures: [],
              latestWarningAndErrorLogs: [],
              partialFailure: Option.none(),
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(gitManagerLayer),
      Layer.provide(gitVcsDriverLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(reviewLayer),
      Layer.provide(vcsProvisioningLayer),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          ...options?.layers?.sourceControlRepositoryService,
        }),
      ),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager.TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PreviewManager.PreviewManager)({
            open: () => Effect.die("PreviewManager not stubbed in this test"),
            navigate: () => Effect.die("PreviewManager not stubbed in this test"),
            resize: () => Effect.die("PreviewManager not stubbed in this test"),
            reportStatus: () => Effect.void,
            refresh: () => Effect.void,
            close: () => Effect.void,
            list: () => Effect.succeed({ sessions: [], serverEpoch: "test-server", revision: 0 }),
            events: Stream.empty,
            subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          }),
          Layer.mock(PortScanner.PortDiscovery)({
            scan: () => Effect.succeed([]),
            subscribe: () => Effect.void,
            retain: Effect.void,
            registerTerminalProcesses: () => Effect.void,
            unregisterTerminal: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 0 }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
            ...options?.layers?.orchestrationEngine,
          }),
          Layer.mock(ThreadDeletionReactor)({
            start: () => Effect.void,
            drainThrough: () => Effect.void,
            ...options?.layers?.threadDeletionReactor,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getUserInputActivity: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          searchThreads: () => Effect.succeed({ matches: [] }),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getEventReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) =>
            Effect.succeed({
              eventCount: Math.max(0, toSequenceInclusive - fromSequenceExclusive),
              payloadBytes: 0,
            }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(resourceTelemetryLayer),
      Layer.provide(UsageService.layerTest),
      Layer.provide(
        Layer.mock(AnalyticsService.AnalyticsService)({
          record: () => Effect.void,
          flush: Effect.void,
          ...options?.layers?.analyticsService,
        }),
      ),
      Layer.provide(
        Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          markRunningProviderSessionsForContinuation: Effect.succeed([]),
          clearProviderSessionContinuationMarkers: () => Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
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
            shouldRunOpportunisticWork: false,
            updatedAt: TEST_EPOCH,
          }),
          streamChanges: Stream.empty,
          subscribe: Effect.succeed({
            latest: {
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
              shouldRunOpportunisticWork: false,
              updatedAt: TEST_EPOCH,
            },
            changes: Stream.empty,
          }),
          hasDemand: () => Effect.succeed(false),
          shouldRunScopeWork: () => Effect.succeed(false),
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          CloudManagedEndpointRuntime.CloudManagedEndpointRuntime,
          CloudManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: () => Effect.succeed({ status: "disabled" }),
            ...options?.layers?.cloudManagedEndpointRuntime,
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused relay-client install"),
            installWithProgress: () => Effect.die("unused relay-client install"),
            ...options?.layers?.relayClient,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(CloudCliTokenManager.CloudCliTokenManager)({
          get: Effect.die(new Error("Unexpected T3 Connect CLI authorization request.")),
          getExisting: Effect.succeed(Option.none()),
          hasCredential: Effect.succeed(false),
          clear: Effect.void,
          ...options?.layers?.cloudCliTokenManager,
        }),
      ),
      Layer.updateService(PairingGrantStore.PairingGrantStore, (grants) => {
        const subscribed = options?.onPairingChangesSubscribed;
        if (!subscribed) return grants;
        return {
          ...grants,
          streamChanges: Stream.unwrap(
            Effect.gen(function* () {
              const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
              yield* grants.streamChanges.pipe(
                Stream.runForEach((change) => Queue.offer(changes, change)),
                Effect.forkScoped({ startImmediately: true }),
              );
              yield* subscribed;
              return Stream.fromQueue(changes);
            }),
          ),
        };
      }),
      Layer.provideMerge(makeAuthTestLayer()),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return {
    cookie,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (wsUrl: string, onMessage?: (message: string) => void) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      const socket = new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
        cookie ? { headers: { cookie } } : undefined,
      );
      if (onMessage) socket.on("message", (data) => onMessage(data.toString()));
      return socket as unknown as globalThis.WebSocket;
    },
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
  onMessage?: (message: string) => void,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl, onMessage)));

const withFirstWsAckHeld = (
  wsUrl: string,
  held: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  let holdNextAck = true;
  return Layer.effect(RpcClient.Protocol)(
    Effect.map(RpcClient.Protocol, (protocol) =>
      RpcClient.Protocol.of({
        ...protocol,
        send: (clientId, request, transferables) => {
          const send = protocol.send(clientId, request, transferables);
          if (request._tag !== "Ack" || !holdNextAck) {
            return send;
          }
          holdNextAck = false;
          return Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(send),
          );
        },
      }),
    ),
  ).pipe(Layer.provide(wsRpcProtocolLayer(wsUrl)));
};

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/browser-session");
    const response = yield* fetchEffect(bootstrapUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options?.headers,
      },
      body: jsonRequestBody({
        credential,
      }),
    });
    const body = yield* responseJsonEffect<{
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    }>(response);
    return {
      response,
      body,
      cookie: response.headers["set-cookie"],
    };
  });

const exchangeAccessToken = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
    readonly scope?: string;
    readonly clientMetadata?: {
      readonly label?: string;
      readonly deviceType?: string;
      readonly os?: string;
    };
  },
) =>
  Effect.gen(function* () {
    const tokenUrl = yield* getHttpServerUrl("/oauth/token");
    const response = yield* fetchEffect(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options?.headers,
      },
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope:
          options?.scope ??
          "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
        ...(options?.clientMetadata?.label ? { client_label: options.clientMetadata.label } : {}),
        ...(options?.clientMetadata?.deviceType
          ? { client_device_type: options.clientMetadata.deviceType }
          : {}),
        ...(options?.clientMetadata?.os ? { client_os: options.clientMetadata.os } : {}),
      }).toString(),
    });
    const body = yield* responseJsonEffect<{
      readonly access_token?: string;
      readonly issued_token_type?: string;
      readonly token_type?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly _tag?: string;
      readonly code?: string;
      readonly reason?: string;
      readonly dpopFailureReason?: DpopFailureReason;
      readonly traceId?: string;
    }>(response);
    return {
      response,
      body,
    };
  });

const makeDpopProof = (input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly accessToken?: string;
  readonly jti?: string;
  readonly privateKey?: NodeCrypto.KeyObject;
  readonly publicJwk?: DpopPublicJwk;
}) => {
  const keyPair =
    input.privateKey && input.publicJwk
      ? { privateKey: input.privateKey, publicJwk: input.publicJwk }
      : (() => {
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk };
        })();
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti ?? "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(keyPair.publicJwk),
    privateKey: keyPair.privateKey,
    publicJwk: keyPair.publicJwk,
  };
};

const makeCloudMintCredentialRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly clientProofKeyThumbprint: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:connect">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t3-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-mint-jti-1",
    environmentId: input.environmentId,
    clientProofKeyThumbprint: input.clientProofKeyThumbprint,
    cnf: {
      jkt: input.clientProofKeyThumbprint,
    },
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:connect"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_MINT_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const makeCloudEnvironmentHealthRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:status">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t3-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-health-jti-1",
    environmentId: input.environmentId,
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:status"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_HEALTH_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const decodeCompactJwtPayload = <A>(token: string): A => {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    throw new Error("JWT does not contain a payload.");
  }
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as A;
};

class AuthenticationGetterError extends Data.TaggedError("AuthenticationGetterError")<{
  readonly message: string;
}> {}

class TestHttpRequestError extends Data.TaggedError("TestHttpRequestError")<{
  readonly cause: unknown;
}> {}

const testRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  const value = input.toString();
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

const fetchEffect = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = HttpClientRequest.make((init?.method ?? "GET") as "GET" | "POST")(
    testRequestUrl(input),
    {
      headers: init?.headers as Record<string, string> | undefined,
    },
  ).pipe(
    typeof init?.body === "string"
      ? HttpClientRequest.bodyText(
          init.body,
          (init.headers as Record<string, string> | undefined)?.["content-type"] ??
            "application/json",
        )
      : (request) => request,
  );
  const effect = HttpClient.execute(request);
  return (
    init?.redirect === "manual"
      ? effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
      : effect
  ).pipe(Effect.mapError((cause) => new TestHttpRequestError({ cause })));
};

const jsonRequestBody = (value: unknown): string => {
  return JSON.stringify(value);
};

const responseJsonEffect = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) => json as A),
    Effect.mapError((cause) => new TestHttpRequestError({ cause })),
  );

const responseOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bootstrap session response to succeed, got ${response.status}`,
      });
    }

    if (!cookie) {
      return yield* new AuthenticationGetterError({
        message: "Expected bootstrap session response to set a cookie.",
      });
    }

    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* exchangeAccessToken(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bearer bootstrap response to succeed, got ${response.status}`,
      });
    }

    if (!body.access_token) {
      return yield* new AuthenticationGetterError({
        message: "Expected token exchange response to include an access token.",
      });
    }

    return body.access_token;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const assertBrowserApiCorsResponseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assert.equal(headers["access-control-allow-origin"], options?.origin ?? "*");
  assert.equal(
    headers["access-control-allow-credentials"],
    options?.credentials ? "true" : undefined,
  );
};

const assertBrowserApiCorsPreflightHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assertBrowserApiCorsResponseHeaders(headers, options);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-methods"] ?? null), [
    "GET",
    "OPTIONS",
    "POST",
  ]);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-headers"]), [
    "authorization",
    "b3",
    "content-type",
    "dpop",
    "traceparent",
  ]);
};
const crossOriginClientOrigin = "http://remote-client.test:3773";

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`;
    if (options?.authenticated === false) {
      return baseUrl;
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    );
  });

// Mirrors NodeHttpServer.layerTest, which does not expose server options,
// with the production `websocket: { perMessageDeflate: true }` setting.
const NodeHttpServerTestWithWsDeflate = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.map(
        Effect.promise(() => import("node:http")),
        (NodeHttp) =>
          NodeHttpServer.layer(NodeHttp.createServer, {
            port: 0,
            websocket: { perMessageDeflate: true },
          }),
      ),
    ),
  ),
);

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("parks HTTP ingress until command readiness", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-gate-" });
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "ready");
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        config: { staticDir },
        layers: {
          serverRuntimeStartup: {
            awaitCommandReady: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(ready)),
            ),
          },
        },
      });
      const request = yield* HttpClient.get("/").pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      assert.isFalse(yield* Deferred.isDone(completed));

      yield* Deferred.succeed(ready, undefined);
      assert.equal((yield* Fiber.join(request)).status, 200);
      assert.isTrue(yield* Deferred.isDone(completed));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revalidates static files without sending unchanged bodies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-cache-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>first build</html>");
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/");
      assert.equal(initial.status, 200);
      assert.equal(initial.headers["cache-control"], "no-cache");
      assert.include(yield* initial.text, "first build");
      const etag = initial.headers.etag;
      assert.isDefined(etag);
      assert.isDefined(initial.headers["last-modified"]);

      for (const headers of [
        { "if-none-match": etag! },
        { "if-none-match": `"older", ${etag!.replace(/^W\//, "")}` },
        { "if-none-match": "*" },
        { "if-modified-since": initial.headers["last-modified"]! },
      ]) {
        const response = yield* HttpClient.get("/", { headers });
        assert.equal(response.status, 304);
        assert.equal(response.headers.etag, etag);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(yield* response.text, "");
      }

      const mismatched = yield* HttpClient.get("/", {
        headers: {
          "if-none-match": '"another-build"',
          "if-modified-since": initial.headers["last-modified"]!,
        },
      });
      assert.equal(mismatched.status, 200);
      assert.include(yield* mismatched.text, "first build");

      yield* fileSystem.writeFileString(indexPath, "<html>the next build is available</html>");
      const changed = yield* HttpClient.get("/", { headers: { "if-none-match": etag! } });
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.etag, etag);
      assert.include(yield* changed.text, "next build");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caches hashed static assets without freezing mutable files or SPA fallbacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-hashes-" });
      yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
      yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
      yield* fileSystem.writeFileString(
        path.join(staticDir, ".vite", "manifest.json"),
        `{
          "index.html": { "file": "assets/index-AbCd0123.js", "isEntry": true },
          "large.js": { "file": "assets/large-aBcD9876.js" }
        }`,
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html>app</html>");
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "index-AbCd0123.js"),
        "export const app = true;",
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "assets", "config.json"), "{}");
      const largeAsset = "export const value = 123;\n".repeat(8192);
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "large-aBcD9876.js"),
        largeAsset,
      );
      yield* buildAppUnderTest({ config: { staticDir } });

      const asset = yield* HttpClient.get("/assets/index-AbCd0123.js");
      assert.equal(asset.status, 200);
      assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(yield* asset.text, "export const app = true;");

      const head = yield* HttpClient.head("/assets/index-AbCd0123.js", {
        headers: { "accept-encoding": "identity" },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.etag, asset.headers.etag);
      assert.equal(head.headers["content-length"], String("export const app = true;".length));
      assert.equal(yield* head.text, "");

      const compressed = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(compressed.headers["content-encoding"], "gzip");
      assert.equal(compressed.headers.vary, "Accept-Encoding");
      assert.equal(yield* compressed.text, largeAsset);
      const compressedHead = yield* HttpClient.head("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(compressedHead.status, 200);
      assert.equal(compressedHead.headers["content-encoding"], "gzip");
      assert.equal(compressedHead.headers.vary, "Accept-Encoding");
      assert.equal(compressedHead.headers.etag, compressed.headers.etag);
      assert.equal(compressedHead.headers["content-length"], compressed.headers["content-length"]);
      assert.equal(yield* compressedHead.text, "");
      const unchanged = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "identity", "if-none-match": compressed.headers.etag! },
      });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.vary, "Accept-Encoding");
      assert.equal(yield* unchanged.text, "");

      for (const resource of [
        "/assets/config.json",
        "/threads/example",
        "/assets/old-ZyXw9876.js",
      ]) {
        const response = yield* HttpClient.get(resource);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(
          yield* response.text,
          resource.endsWith("config.json") ? "{}" : "<html>app</html>",
        );
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const manifest of [
    { label: "missing", contents: null },
    { label: "nonmatching", contents: '{"other.js":{"file":"assets/other-AbCd0123.js"}}' },
    { label: "malformed", contents: "{not-json" },
  ]) {
    it.effect(`revalidates hash-like static filenames with a ${manifest.label} manifest`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-static-mutable-",
        });
        yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
        if (manifest.contents !== null) {
          yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
          yield* fileSystem.writeFileString(
            path.join(staticDir, ".vite", "manifest.json"),
            manifest.contents,
          );
        }
        const filePath = path.join(staticDir, "assets", "config-20260904.js");
        yield* fileSystem.writeFileString(filePath, "first config");
        yield* buildAppUnderTest({ config: { staticDir } });

        const initial = yield* HttpClient.get("/assets/config-20260904.js");
        assert.equal(initial.headers["cache-control"], "no-cache");
        assert.equal(yield* initial.text, "first config");

        yield* fileSystem.writeFileString(filePath, "replacement config");
        const changed = yield* HttpClient.get("/assets/config-20260904.js", {
          headers: { "if-none-match": initial.headers.etag! },
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.headers["cache-control"], "no-cache");
        assert.notEqual(changed.headers.etag, initial.headers.etag);
        assert.equal(yield* changed.text, "replacement config");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("binds static metadata and bytes to one file across atomic replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-replace-" });
      const beforeOpenPath = path.join(staticDir, "before-open.txt");
      const afterOpenPath = path.join(staticDir, "after-open.txt");
      const original = "original bytes";
      const replacement = "replacement bytes with a different size";
      for (const filePath of [beforeOpenPath, afterOpenPath]) {
        yield* fileSystem.writeFileString(filePath, original);
        yield* fileSystem.writeFileString(`${filePath}.next`, replacement);
      }
      const replaced = new Set<string>();
      const replaceOnce = Effect.fnUntraced(function* (filePath: string) {
        if (replaced.has(filePath)) return;
        replaced.add(filePath);
        yield* fileSystem.rename(`${filePath}.next`, filePath);
      });
      const replacingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (filePath) =>
          fileSystem
            .stat(filePath)
            .pipe(
              Effect.tap(() => (filePath === beforeOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
        open: (filePath, options) =>
          fileSystem
            .open(filePath, options)
            .pipe(
              Effect.tap(() => (filePath === afterOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
      });
      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, replacingFileSystem),
      );

      for (const [name, expected] of [
        ["before-open.txt", replacement],
        ["after-open.txt", original],
      ] as const) {
        const response = yield* HttpClient.get(`/${name}`, {
          headers: { "accept-encoding": "identity" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers["content-length"], String(expected.length));
        assert.isTrue(response.headers.etag?.startsWith(`W/"${expected.length.toString(16)}-`));
        assert.equal(yield* response.text, expected);
        assert.isTrue(replaced.has(path.join(staticDir, name)));
        assert.equal(yield* fileSystem.readFileString(path.join(staticDir, name)), replacement);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes static file handles after GET, HEAD, 304, and request cancellation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-close-" });
      const filePath = path.join(staticDir, "index.html");
      const body = "<p>file content</p>".repeat(1024);
      yield* fileSystem.writeFileString(filePath, body);
      const closed = yield* Queue.unbounded<FileSystem.File>();
      const blocked = yield* Deferred.make<void>();
      const active = new Set<FileSystem.File>();
      let blockAfterOpen = false;
      let bodyReads = 0;
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fileSystem.open(candidate, options);
            let opened: FileSystem.File | undefined;
            // Registered first, so this signal runs after the real descriptor-close finalizer.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (opened === undefined) return;
                active.delete(opened);
                yield* Queue.offer(closed, opened);
              }),
            );
            const file = yield* fileSystem.open(candidate, options);
            opened = file;
            active.add(file);
            if (blockAfterOpen) {
              yield* Deferred.succeed(blocked, undefined);
              return yield* Effect.never;
            }
            return new Proxy(file, {
              get(target, key) {
                if (key === "readAlloc") {
                  return (size: FileSystem.SizeInput) => {
                    bodyReads += 1;
                    return target.readAlloc(size);
                  };
                }
                return Reflect.get(target, key, target);
              },
            });
          }),
      });
      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );

      const get = yield* HttpClient.get("/");
      assert.equal(yield* get.text, body);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.isAbove(bodyReads, 0);
      const readsAfterGet = bodyReads;

      const head = yield* HttpClient.head("/", { headers: { "accept-encoding": "gzip" } });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-encoding"], "gzip");
      assert.equal(yield* head.text, "");
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      const unchanged = yield* HttpClient.get("/", {
        headers: { "if-none-match": get.headers.etag! },
      });
      assert.equal(unchanged.status, 304);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      blockAfterOpen = true;
      const cancelled = yield* HttpClient.get("/").pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      assert.equal(active.size, 1);
      yield* Fiber.interrupt(cancelled);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* fetchEffect(url, { redirect: "manual" });

      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "http://127.0.0.1:5173/foo/bar?token=test-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the public environment descriptor without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url);
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves snapshots for MCP handoff thread IDs above the router default", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(
        "thread:mcp:abfba0d2-b591-4b7e-aad1-e943d89811fa:handoff%3A0ae5edf4-2ea3-4ee3-ba7c-48de3ac92896%3A2026-08-24T17%3A08%3A52.138Z:0",
      );
      const thread = {
        ...makeDefaultOrchestrationReadModel().threads[0]!,
        id: threadId,
      };
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: (requestedThreadId) =>
              Effect.succeed(
                requestedThreadId === threadId
                  ? Option.some({ snapshotSequence: 1, thread })
                  : Option.none(),
              ),
          },
        },
      });

      const response = yield* fetchEffect(
        yield* getHttpServerUrl(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
        { headers: { cookie: yield* getAuthenticatedSessionCookieHeader() } },
      );
      const snapshot = yield* responseJsonEffect<{
        readonly thread: { readonly id: ThreadId };
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(snapshot.thread.id, threadId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("compresses large JSON responses through the composed routes", () =>
    Effect.gen(function* () {
      const descriptor = {
        ...testEnvironmentDescriptor,
        label: "Test environment".repeat(100),
      };
      yield* buildAppUnderTest({
        layers: {
          serverEnvironment: {
            getDescriptor: Effect.succeed(descriptor),
          },
        },
      });

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url, {
        headers: {
          "accept-encoding": "gzip",
        },
      });
      const body = yield* responseJsonEffect<typeof descriptor>(response);

      assert.equal(response.status, 200);
      assert.equal(response.headers["content-encoding"], "gzip");
      assert.equal(response.headers.vary, "Accept-Encoding");
      assert.deepEqual(body, descriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on public environment descriptor responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* fetchEffect(url, {
        headers: {
          origin: crossOriginClientOrigin,
        },
      });
      const body = yield* responseJsonEffect<typeof testEnvironmentDescriptor>(response);

      assert.equal(response.status, 200);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports unauthenticated session state without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(url);
      const body = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
          readonly sessionMethods: ReadonlyArray<string>;
          readonly sessionCookieName: string;
        };
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.equal(body.auth.policy, "desktop-managed-local");
      assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
      assert.deepEqual(body.auth.sessionMethods, [
        "browser-session-cookie",
        "bearer-access-token",
        "dpop-access-token",
      ]);
      // Desktop, so port-scoped: instances scan for a free port and share
      // 127.0.0.1, and cookies are not scoped by port.
      assert.isTrue(body.auth.sessionCookieName.startsWith("t3_session_"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bootstraps a browser session and authenticates the session endpoint via cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
      assert.isDefined(setCookie);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          cookie: setCookie?.split(";")[0] ?? "",
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("migrates a valid legacy remote-web session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { mode: "web", host: "192.168.1.50" } });

      const { cookie } = yield* bootstrapBrowserSession();
      const currentCookie = cookie?.split(";")[0] ?? "";
      const legacyCookie = currentCookie.replace(/^t3_session_[^=]+=/, "t3_session=");
      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(sessionUrl, {
        headers: { cookie: legacyCookie },
      });
      const body = yield* responseJsonEffect<{ readonly authenticated: boolean }>(response);

      assert.equal(body.authenticated, true);
      assert.equal(response.headers["set-cookie"], cookie);
      assert.equal(response.headers["cache-control"], "no-store");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each(["cookie", "bearer"])(
    "does not migrate a stale legacy cookie when %s auth succeeds",
    (source) =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ config: { mode: "web", host: "192.168.1.50" } });

        const { cookie } = yield* bootstrapBrowserSession();
        const sessionCookie = cookie?.split(";")[0] ?? "";
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(sessionUrl, {
          headers:
            source === "cookie"
              ? { cookie: `${sessionCookie}; t3_session=stale` }
              : { authorization: `Bearer ${sessionToken}`, cookie: "t3_session=stale" },
        });
        const body = yield* responseJsonEffect<{ readonly authenticated: boolean }>(response);

        assert.equal(body.authenticated, true);
        assert.isUndefined(response.headers["set-cookie"]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("exchanges a bootstrap grant for a scoped bearer access token", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken();

      assert.equal(tokenResponse.status, 200);
      assert.equal(tokenBody.issued_token_type, AuthAccessTokenType);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(
        tokenBody.scope,
        "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
      );
      assert.equal(typeof tokenBody.access_token, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
        readonly scopes?: ReadonlyArray<string>;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");
      assert.deepEqual(sessionBody.scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("replaces the local desktop credential on repeated bootstrap exchanges", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const first = yield* exchangeAccessToken();
      const second = yield* exchangeAccessToken();
      const third = yield* exchangeAccessToken();
      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);
      assert.equal(third.response.status, 200);

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: { authorization: `Bearer ${third.body.access_token}` },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly current: boolean;
        readonly subject: string;
      }>;
      assert.equal(clientsResponse.status, 200);
      assert.equal(clients.length, 1);
      assert.equal(clients[0]?.current, true);
      assert.equal(clients[0]?.subject, "desktop-bootstrap");

      for (const previous of [first, second]) {
        const response = yield* HttpClient.get("/api/auth/session", {
          headers: { authorization: `Bearer ${previous.body.access_token}` },
        });
        const state = (yield* response.json) as { readonly authenticated: boolean };
        assert.equal(state.authenticated, false);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("persists token exchange client display metadata for authorized-client listings", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };

      const { response } = yield* exchangeAccessToken(pairingBody.credential, {
        headers: {
          "user-agent": "undici",
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
        clientMetadata: {
          label: "T3 Code Mobile",
          deviceType: "mobile",
          os: "iOS",
        },
      });

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly userAgent?: string;
        };
      }>;
      const mobileClient = clients.find((client) => !client.current);

      assert.equal(pairingResponse.status, 200);
      assert.equal(response.status, 200);
      assert.equal(clientsResponse.status, 200);
      assert.deepInclude(mobileClient?.client, {
        label: "T3 Code Mobile",
        deviceType: "mobile",
        os: "iOS",
        ipAddress: "127.0.0.1",
        userAgent: "undici",
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "exchanges a bootstrap credential for a DPoP-bound access token without bearer downgrade",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        const credential = (yield* credentialResponse.json) as { readonly credential: string };
        const tokenUrl = yield* getHttpServerUrl("/oauth/token");
        const now = yield* DateTime.now;
        const tokenProof = makeDpopProof({
          method: "POST",
          url: tokenUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: "token-exchange-proof",
        });
        const tokenResponse = yield* fetchEffect(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: tokenProof.proof,
          },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: credential.credential,
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            scope: "orchestration:read orchestration:operate terminal:operate review:write",
          }).toString(),
        });
        const token = yield* responseJsonEffect<{
          readonly access_token: string;
          readonly token_type: string;
        }>(tokenResponse);

        assert.equal(tokenResponse.status, 200);
        assert.equal(tokenResponse.headers["cache-control"], "no-store");
        assert.equal(token.token_type, "DPoP");

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const bearerResponse = yield* fetchEffect(sessionUrl, {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        const bearerState = yield* responseJsonEffect<{ readonly authenticated: boolean }>(
          bearerResponse,
        );
        assert.equal(bearerState.authenticated, false);

        const sessionProof = makeDpopProof({
          method: "GET",
          url: sessionUrl,
          iat: Math.floor(now.epochMilliseconds / 1_000),
          jti: "session-proof",
          accessToken: token.access_token,
          privateKey: tokenProof.privateKey,
          publicJwk: tokenProof.publicJwk,
        });
        const dpopResponse = yield* fetchEffect(sessionUrl, {
          headers: {
            authorization: `DPoP ${token.access_token}`,
            dpop: sessionProof.proof,
          },
        });
        const dpopState = yield* responseJsonEffect<{
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        }>(dpopResponse);
        assert.equal(dpopState.authenticated, true);
        assert.equal(dpopState.sessionMethod, "dpop-access-token");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports clock skew for a future-dated DPoP token exchange proof", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000) + 25,
      });

      const exchange = yield* exchangeAccessToken(credential.credential, {
        headers: { dpop: dpop.proof },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(exchange.response.status, 401);
      assert.equal(exchange.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(exchange.body.code, "auth_invalid");
      assert.equal(exchange.body.reason, "invalid_credential");
      assert.equal(exchange.body.dpopFailureReason, "time_window");
      assert.equal(typeof exchange.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed DPoP proofs across token exchanges", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const firstCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const firstCredential = (yield* firstCredentialResponse.json) as {
        readonly credential: string;
      };
      const secondCredentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const secondCredential = (yield* secondCredentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const firstBootstrap = yield* exchangeAccessToken(firstCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });
      const replayBootstrap = yield* exchangeAccessToken(secondCredential.credential, {
        headers: {
          dpop: dpop.proof,
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(firstBootstrap.response.status, 200);
      assert.equal(replayBootstrap.response.status, 401);
      assert.equal(replayBootstrap.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(replayBootstrap.body.code, "auth_invalid");
      assert.equal(replayBootstrap.body.reason, "invalid_credential");
      assert.equal(replayBootstrap.body.dpopFailureReason, "replay");
      assert.equal(typeof replayBootstrap.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores forwarded host headers when validating token exchange DPoP URLs", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: tokenUrl,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          "x-forwarded-host": "environment.example.test",
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(bootstrap.response.status, 200);
      assert.equal(bootstrap.body.token_type, "DPoP");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects token exchange DPoP proofs bound to spoofed forwarded hosts", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as {
        readonly credential: string;
      };
      const tokenUrl = yield* getHttpServerUrl("/oauth/token");
      const spoofedUrl = new URL(tokenUrl);
      spoofedUrl.hostname = "environment.example.test";
      const now = yield* DateTime.now;
      const dpop = makeDpopProof({
        method: "POST",
        url: spoofedUrl.href,
        iat: Math.floor(now.epochMilliseconds / 1_000),
      });

      const bootstrap = yield* exchangeAccessToken(credential.credential, {
        headers: {
          dpop: dpop.proof,
          "x-forwarded-host": spoofedUrl.host,
        },
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      assert.equal(bootstrap.response.status, 401);
      assert.equal(bootstrap.body._tag, "EnvironmentAuthInvalidError");
      assert.equal(bootstrap.body.code, "auth_invalid");
      assert.equal(bootstrap.body.reason, "invalid_credential");
      assert.equal(bootstrap.body.dpopFailureReason, "request_mismatch");
      assert.equal(typeof bootstrap.body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs for non-loopback managed endpoint origins", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "manual",
          },
          origin: {
            localHttpHost: "192.168.1.42",
            localHttpPort: 3773,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs for unsupported endpoint providers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: linkProofUrl.replace("/api/connect/link-proof", ""),
            wsBaseUrl: linkProofUrl
              .replace("http://", "ws://")
              .replace("/api/connect/link-proof", "/ws"),
            // "manual" and "cloudflare_tunnel" are supported; "t3_relay" is not.
            providerKind: "t3_relay",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: serverPort,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs requested through a public managed endpoint", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          host: "environment.example.test",
          "x-forwarded-host": "environment.example.test",
          "x-forwarded-proto": "https",
        },
        body: HttpBody.text(
          jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "manual",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
          "application/json",
        ),
      });
      const body = (yield* linkProofResponse.json) as {
        readonly _tag?: string;
        readonly message?: string;
      };

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects cloud link proofs when a public request spoofs loopback forwarded headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
        const serverPort = Number(new URL(linkProofUrl).port);
        const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
            host: "environment.example.test",
            "x-forwarded-host": `127.0.0.1:${serverPort}`,
            "x-forwarded-proto": "http",
          },
          body: HttpBody.text(
            jsonRequestBody({
              challenge: "relay-link-challenge",
              relayIssuer: "https://relay.example.test",
              endpoint: {
                httpBaseUrl: "https://environment.example.test/",
                wsBaseUrl: "wss://environment.example.test/ws",
                providerKind: "manual",
              },
              origin: {
                localHttpHost: "127.0.0.1",
                localHttpPort: serverPort,
              },
            }),
            "application/json",
          ),
        });
        const body = (yield* linkProofResponse.json) as {
          readonly _tag?: string;
          readonly message?: string;
        };

        assert.equal(linkProofResponse.status, 400);
        assert.equal(body._tag, "EnvironmentHttpBadRequestError");
        assert.equal(body.message, "Invalid managed endpoint origin.");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud link proofs with malformed forwarded request hosts", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* HttpClient.post("/api/connect/link-proof", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          host: "bad host",
          "x-forwarded-host": "bad host",
          "x-forwarded-proto": "https",
        },
        body: HttpBody.text(
          jsonRequestBody({
            challenge: "relay-link-challenge",
            relayIssuer: "https://relay.example.test",
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "manual",
            },
            origin: {
              localHttpHost: "127.0.0.1",
              localHttpPort: serverPort,
            },
          }),
          "application/json",
        ),
      });
      const body = (yield* linkProofResponse.json) as {
        readonly _tag?: string;
        readonly message?: string;
      };

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects local cloud link proofs for a different loopback port", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const serverPort = Number(new URL(linkProofUrl).port);
      const linkProofResponse = yield* fetchEffect(linkProofUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          challenge: "relay-link-challenge",
          relayIssuer: "https://relay.example.test",
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "manual",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: serverPort === 65_535 ? serverPort - 1 : serverPort + 1,
          },
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(linkProofResponse);

      assert.equal(linkProofResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Invalid managed endpoint origin.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows standard clients to read managed relay configuration state", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const response = yield* fetchEffect(linkStateUrl, {
        headers: { cookie: pairedCookie },
      });
      const body = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly publishAgentActivity?: boolean;
      }>(response);

      assert.equal(response.status, 200);
      assert.equal(body.linked, false);
      assert.equal(body.publishAgentActivity, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "reports relay client status and streams installation progress over environment RPC",
    () =>
      Effect.gen(function* () {
        const installedRelayClient = {
          status: "available" as const,
          executablePath: "/tmp/t3/tools/cloudflared",
          source: "managed" as const,
          version: RelayClient.CLOUDFLARED_VERSION,
        };
        yield* buildAppUnderTest({
          layers: {
            relayClient: {
              resolve: Effect.succeed({
                status: "missing",
                version: RelayClient.CLOUDFLARED_VERSION,
              }),
              install: Effect.succeed(installedRelayClient),
              installWithProgress: (report) =>
                report({ type: "progress", stage: "checking" }).pipe(
                  Effect.andThen(report({ type: "progress", stage: "downloading" })),
                  Effect.as(installedRelayClient),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const status = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.cloudGetRelayClientStatus]({})),
        );
        const installEvents = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.cloudInstallRelayClient]({}).pipe(Stream.runCollect),
          ),
        );

        assert.equal(status.status, "missing");
        assert.deepEqual(Array.from(installEvents), [
          { type: "progress", stage: "checking" },
          { type: "progress", stage: "downloading" },
          { type: "complete", status: installedRelayClient },
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires relay write scope to update agent activity publication", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const preferencesUrl = yield* getHttpServerUrl("/api/connect/preferences");
      const ownerResponse = yield* fetchEffect(preferencesUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({ publishAgentActivity: true }),
      });
      const ownerBody = yield* responseJsonEffect<{
        readonly publishAgentActivity?: boolean;
      }>(ownerResponse);
      assert.equal(ownerResponse.status, 200);
      assert.equal(ownerBody.publishAgentActivity, true);

      const credentialResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: ownerCookie },
        body: yield* HttpBody.json({}),
      });
      const credential = (yield* credentialResponse.json) as { readonly credential: string };
      const pairedCookie = yield* getAuthenticatedSessionCookieHeader(credential.credential);
      const pairedResponse = yield* fetchEffect(preferencesUrl, {
        method: "POST",
        headers: {
          cookie: pairedCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({ publishAgentActivity: false }),
      });
      const pairedBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly requiredScope?: string;
      }>(pairedResponse);
      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
      assert.equal(pairedBody.requiredScope, "relay:write");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config with an invalid cloud mint public key", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: "not-a-public-key",
          endpointRuntime: null,
        }),
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(relayConfigResponse);

      assert.equal(relayConfigResponse.status, 400);
      assert.equal(body._tag, "EnvironmentHttpBadRequestError");
      assert.equal(body.message, "Cloud mint public key must be a valid Ed25519 public key.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config with insecure relay metadata or empty credentials", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const postRelayConfig = (body: {
        readonly relayUrl: string;
        readonly relayIssuer?: string;
        readonly cloudUserId: string;
        readonly environmentCredential: string;
      }) =>
        fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            ...body,
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });

      const insecureRelayUrl = yield* postRelayConfig({
        relayUrl: "http://relay.example.test",
        cloudUserId: "user_123",
        environmentCredential: "t3env_test_credential",
      });
      const insecureRelayIssuer = yield* postRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user_123",
        relayIssuer: "http://relay.example.test",
        environmentCredential: "t3env_test_credential",
      });
      const nonOriginRelayUrl = yield* postRelayConfig({
        relayUrl: "https://relay.example.test/path",
        cloudUserId: "user_123",
        environmentCredential: "t3env_test_credential",
      });
      const emptyCredential = yield* postRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user_123",
        environmentCredential: "   ",
      });
      const insecureRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
        insecureRelayUrl,
      );
      const insecureRelayIssuerBody = yield* responseJsonEffect<{ readonly message?: string }>(
        insecureRelayIssuer,
      );
      const nonOriginRelayUrlBody = yield* responseJsonEffect<{ readonly message?: string }>(
        nonOriginRelayUrl,
      );
      const emptyCredentialBody = yield* responseJsonEffect<{ readonly message?: string }>(
        emptyCredential,
      );

      assert.equal(insecureRelayUrl.status, 400);
      assert.equal(insecureRelayUrlBody.message, "Relay URL must be a secure absolute HTTPS URL.");
      assert.equal(insecureRelayIssuer.status, 400);
      assert.equal(
        insecureRelayIssuerBody.message,
        "Relay issuer must be a secure absolute HTTPS URL.",
      );
      assert.equal(nonOriginRelayUrl.status, 400);
      assert.equal(nonOriginRelayUrlBody.message, "Relay URL must be a secure absolute HTTPS URL.");
      assert.equal(emptyCredential.status, 400);
      assert.equal(emptyCredentialBody.message, "Relay environment credential is required.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects relay config replacement from a different cloud account", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const postRelayConfig = (cloudUserId: string, environmentCredential: string) =>
        fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://relay.example.test",
            cloudUserId,
            environmentCredential,
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });

      const firstResponse = yield* postRelayConfig("user_123", "t3env_first_credential");
      const replacementResponse = yield* postRelayConfig("user_456", "t3env_second_credential");
      const replacementBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replacementResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replacementResponse.status, 409);
      assert.equal(replacementBody._tag, "EnvironmentHttpConflictError");
      assert.equal(
        replacementBody.message,
        "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports local cloud link state from persisted relay config", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");

      const initialResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const initialBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
      }>(initialResponse);
      assert.equal(initialResponse.status, 200);
      assert.equal(initialBody.linked, false);
      assert.equal(initialBody.cloudUserId, null);

      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://transport.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const linkedResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const linkedBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
        readonly relayUrl?: string | null;
        readonly relayIssuer?: string | null;
      }>(linkedResponse);

      assert.equal(linkedResponse.status, 200);
      assert.equal(linkedBody.linked, true);
      assert.equal(linkedBody.cloudUserId, "user_123");
      assert.equal(linkedBody.relayUrl, "https://transport.example.test");
      assert.equal(linkedBody.relayIssuer, "https://relay.example.test");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not expose internal cloud reconciliation over HTTP", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const reconcileUrl = yield* getHttpServerUrl("/api/connect/reconcile");
      const response = yield* fetchEffect(reconcileUrl, {
        method: "POST",
      });

      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("unlinks local cloud state and disables the managed endpoint runtime", () =>
    Effect.gen(function* () {
      const appliedRuntimeConfigs: Array<unknown> = [];
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: (config) => {
              appliedRuntimeConfigs.push(config);
              if (!config) {
                return Effect.succeed({ status: "disabled" });
              }
              return Effect.succeed({
                status: "running",
                providerKind: "cloudflare_tunnel",
                pid: 123,
                ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
                ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
              });
            },
          },
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const unlinkUrl = yield* getHttpServerUrl("/api/connect/unlink");
      const linkStateUrl = yield* getHttpServerUrl("/api/connect/link-state");

      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://transport.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
          },
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const unlinkResponse = yield* fetchEffect(unlinkUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
        },
      });
      const unlinkBody = yield* responseJsonEffect<{
        readonly ok?: boolean;
        readonly endpointRuntimeStatus?: { readonly status?: string };
      }>(unlinkResponse);
      assert.equal(unlinkResponse.status, 200);
      assert.equal(unlinkBody.ok, true);
      assert.equal(unlinkBody.endpointRuntimeStatus?.status, "disabled");

      const linkStateResponse = yield* fetchEffect(linkStateUrl, {
        headers: {
          cookie: ownerCookie,
        },
      });
      const linkStateBody = yield* responseJsonEffect<{
        readonly linked?: boolean;
        readonly cloudUserId?: string | null;
        readonly relayUrl?: string | null;
        readonly relayIssuer?: string | null;
      }>(linkStateResponse);
      assert.equal(linkStateResponse.status, 200);
      assert.equal(linkStateBody.linked, false);
      assert.equal(linkStateBody.cloudUserId, null);
      assert.equal(linkStateBody.relayUrl, null);
      assert.equal(linkStateBody.relayIssuer, null);
      assert.deepEqual(appliedRuntimeConfigs, [
        {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
          tunnelId: "tunnel-id",
          tunnelName: "tunnel-name",
        },
        null,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed cloud mint requests atomically", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudMintCredentialRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        nonce: "cloud-mint-nonce-1",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const mintUrl = yield* getHttpServerUrl("/api/connect/mint-credential");
      const postMint = () =>
        fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const firstResponse = yield* postMint();
      const replayResponse = yield* postMint();
      const replayBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 409);
      assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
      assert.equal(replayBody.message, "Cloud mint request was already consumed.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the documented T3 Connect mint credential endpoint", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudMintCredentialRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        jti: "cloud-mint-jti-documented-endpoint",
        nonce: "cloud-mint-nonce-documented-endpoint",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(request),
      });

      assert.equal(response.status, 200);
      const body = yield* responseJsonEffect<{
        readonly credential?: string;
        readonly proof?: string;
      }>(response);
      assert.equal(typeof body.credential, "string");
      assert.equal(typeof body.proof, "string");
      assert.equal(
        decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
        "cloud-mint-nonce-documented-endpoint",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves signed T3 Connect environment health checks", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        jti: "cloud-health-jti-documented-endpoint",
        nonce: "cloud-health-nonce-documented-endpoint",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(request),
      });

      assert.equal(response.status, 200);
      const body = yield* responseJsonEffect<{
        readonly status?: string;
        readonly descriptor?: { readonly environmentId?: string };
        readonly proof?: string;
      }>(response);
      assert.equal(body.status, "online");
      assert.equal(body.descriptor?.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(typeof body.proof, "string");
      assert.equal(
        decodeCompactJwtPayload<{ readonly requestNonce?: string }>(body.proof!).requestNonce,
        "cloud-health-nonce-documented-endpoint",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects replayed cloud health requests atomically", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const request = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        jti: "cloud-health-jti-replay",
        nonce: "cloud-health-nonce-replay",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const postHealth = () =>
        fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const firstResponse = yield* postHealth();
      const replayResponse = yield* postHealth();
      const replayBody = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly message?: string;
      }>(replayResponse);

      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 409);
      assert.equal(replayBody._tag, "EnvironmentHttpConflictError");
      assert.equal(replayBody.message, "Cloud health request was already consumed.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "validates cloud proofs against the configured relay issuer, not the transport URL",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
        const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: jsonRequestBody({
            relayUrl: "https://transport.example.test",
            cloudUserId: "user_123",
            relayIssuer: "https://relay.example.test",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: cloudKeyPair.publicKey,
            endpointRuntime: null,
          }),
        });
        assert.equal(relayConfigResponse.status, 200);

        const now = yield* DateTime.now;
        const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
        const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
          fetchEffect(mintUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: jsonRequestBody(request),
          });

        const acceptedResponse = yield* postMint(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            issuer: "https://relay.example.test",
            jti: "cloud-mint-jti-explicit-relay-issuer",
            nonce: "cloud-mint-nonce-explicit-relay-issuer",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        );
        const rejectedResponse = yield* postMint(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            issuer: "https://transport.example.test",
            jti: "cloud-mint-jti-transport-url",
            nonce: "cloud-mint-nonce-transport-url",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        );

        assert.equal(acceptedResponse.status, 200);
        assert.equal(rejectedResponse.status, 401);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("fails relay config when the managed endpoint connector cannot start", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          cloudManagedEndpointRuntime: {
            applyConfig: () =>
              Effect.succeed({
                status: "failed",
                providerKind: "cloudflare_tunnel",
                reason: "cloudflared missing",
                tunnelId: "tunnel-1",
              }),
          },
        },
      });

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-1",
          },
        }),
      });

      assert.equal(relayConfigResponse.status, 503);
      const relayConfigBody = yield* responseJsonEffect<{
        _tag?: string;
        message?: string;
        endpointRuntimeStatus?: { status?: string; reason?: string };
      }>(relayConfigResponse);
      assert.equal(relayConfigBody._tag, "EnvironmentCloudEndpointUnavailableError");
      assert.equal(relayConfigBody.message, "Managed endpoint runtime could not be started.");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.status, "failed");
      assert.equal(relayConfigBody.endpointRuntimeStatus?.reason, "cloudflared missing");

      const now = yield* DateTime.now;
      const healthRequest = makeCloudEnvironmentHealthRequest({
        privateKey: cloudKeyPair.privateKey,
        environmentId: testEnvironmentDescriptor.environmentId,
        nonce: "cloud-health-after-failed-runtime",
        issuedAt: DateTime.formatIso(now),
        expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
      });
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const healthResponse = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(healthRequest),
      });
      const healthBody = yield* responseJsonEffect<{
        _tag?: string;
        message?: string;
      }>(healthResponse);
      assert.equal(healthResponse.status, 500);
      assert.equal(healthBody._tag, "EnvironmentHttpInternalServerError");
      assert.equal(
        healthBody.message,
        "Cloud mint public key is not installed for this environment.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests with the wrong issuer or audience", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/connect/mint-credential");
      const postMint = (request: ReturnType<typeof makeCloudMintCredentialRequest>) =>
        fetchEffect(mintUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const wrongIssuer = yield* postMint(
        makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          issuer: "https://attacker.example.test",
          jti: "cloud-mint-jti-wrong-issuer",
          nonce: "cloud-mint-nonce-wrong-issuer",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );
      const wrongAudience = yield* postMint(
        makeCloudMintCredentialRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
          audience: "t3-env:other-environment",
          jti: "cloud-mint-jti-wrong-audience",
          nonce: "cloud-mint-nonce-wrong-audience",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );

      assert.equal(wrongIssuer.status, 401);
      assert.equal(wrongAudience.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests for a cloud subject other than the linked user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            subject: "user_other",
            jti: "cloud-mint-jti-wrong-subject",
            nonce: "cloud-mint-nonce-wrong-subject",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud mint requests without the exact connect scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const mintUrl = yield* getHttpServerUrl("/api/t3-connect/mint-credential");
      const response = yield* fetchEffect(mintUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudMintCredentialRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            clientProofKeyThumbprint: "client-proof-key-thumbprint",
            jti: "cloud-mint-jti-duplicate-scope",
            nonce: "cloud-mint-nonce-duplicate-scope",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            scope: ["environment:connect", "environment:connect"],
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests with the wrong issuer or audience", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const postHealth = (request: ReturnType<typeof makeCloudEnvironmentHealthRequest>) =>
        fetchEffect(healthUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: jsonRequestBody(request),
        });

      const wrongIssuer = yield* postHealth(
        makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          issuer: "https://attacker.example.test",
          jti: "cloud-health-jti-wrong-issuer",
          nonce: "cloud-health-nonce-wrong-issuer",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );
      const wrongAudience = yield* postHealth(
        makeCloudEnvironmentHealthRequest({
          privateKey: cloudKeyPair.privateKey,
          environmentId: testEnvironmentDescriptor.environmentId,
          audience: "t3-env:other-environment",
          jti: "cloud-health-jti-wrong-audience",
          nonce: "cloud-health-nonce-wrong-audience",
          issuedAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
        }),
      );

      assert.equal(wrongIssuer.status, 401);
      assert.equal(wrongAudience.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests for a cloud subject other than the linked user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudEnvironmentHealthRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            subject: "user_other",
            jti: "cloud-health-jti-wrong-subject",
            nonce: "cloud-health-nonce-wrong-subject",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects cloud health requests without the exact status scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const relayConfigUrl = yield* getHttpServerUrl("/api/connect/relay-config");
      const relayConfigResponse = yield* fetchEffect(relayConfigUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          relayUrl: "https://relay.example.test/",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: cloudKeyPair.publicKey,
          endpointRuntime: null,
        }),
      });
      assert.equal(relayConfigResponse.status, 200);

      const now = yield* DateTime.now;
      const healthUrl = yield* getHttpServerUrl("/api/t3-connect/health");
      const response = yield* fetchEffect(healthUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: jsonRequestBody(
          makeCloudEnvironmentHealthRequest({
            privateKey: cloudKeyPair.privateKey,
            environmentId: testEnvironmentDescriptor.environmentId,
            jti: "cloud-health-jti-duplicate-scope",
            nonce: "cloud-health-nonce-duplicate-scope",
            issuedAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            scope: ["environment:status", "environment:status"],
          }),
        ),
      });

      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("negotiates permessage-deflate with clients that offer it", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { cookie, url } = parseSessionCookieFromWsUrl(yield* getWsServerUrl("/ws"));
      const openSocket = (perMessageDeflate: boolean) =>
        Effect.acquireRelease(
          Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume) => {
            const socket = new NodeSocket.NodeWS.WebSocket(url, {
              perMessageDeflate,
              ...(cookie ? { headers: { cookie } } : {}),
            });
            socket.on("open", () => resume(Effect.succeed(socket)));
            socket.on("error", (error) => resume(Effect.fail(error)));
          }),
          (socket) => Effect.sync(() => socket.close()),
        );

      const compressed = yield* openSocket(true);
      // The ws client records the negotiated extension only when the server's
      // 101 response accepted the offer.
      assert.include(compressed.extensions, "permessage-deflate");

      const plain = yield* openSocket(false);
      assert.notInclude(plain.extensions, "permessage-deflate");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServerTestWithWsDeflate)),
  );

  it.effect("issues short-lived websocket tickets for authenticated bearer sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
        readonly expiresAt: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assert.equal(typeof wsTicketBody.ticket, "string");
      assert.isTrue(wsTicketBody.ticket.length > 0);
      assert.equal(typeof wsTicketBody.expiresAt, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not allow management-only access tokens to operate the environment", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: exchangeResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        { scope: "access:write" },
      );
      assert.equal(exchangeResponse.status, 200);
      assert.equal(tokenBody.scope, "access:write");
      assert.isDefined(tokenBody.access_token);

      const overbroadPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({}),
      });
      const overbroadPairingBody = (yield* overbroadPairingResponse.json) as {
        readonly requiredScope: string;
      };
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({ scopes: ["access:write"] }),
      });
      const wsTicketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });
      const wsTicketBody = (yield* wsTicketResponse.json) as { readonly ticket: string };
      assert.equal(overbroadPairingResponse.status, 403);
      assert.equal(overbroadPairingBody.requiredScope, "orchestration:read");
      assert.equal(pairingResponse.status, 200);
      assert.equal(wsTicketResponse.status, 200);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;
      const rpcError = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );
      assert.equal(rpcError._tag, "EnvironmentAuthorizationError");
      if (rpcError._tag === "EnvironmentAuthorizationError") {
        assert.equal(rpcError.requiredScope, "orchestration:read");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote auth success responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const origin = crossOriginClientOrigin;
      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        {
          headers: { origin },
        },
      );

      assert.equal(tokenResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(tokenResponse.headers);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(typeof tokenBody.access_token, "string");

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });
      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(sessionResponse.headers);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });
      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(wsTicketResponse.headers);
      assert.equal(typeof wsTicketBody.ticket, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-ticket preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const response = yield* fetchEffect(wsTicketUrl, {
          method: "OPTIONS",
          headers: {
            origin: crossOriginClientOrigin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows credentialed cloud link proof preflights from the configured dev UI", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL(crossOriginClientOrigin) },
      });

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");
      const response = yield* fetchEffect(linkProofUrl, {
        method: "OPTIONS",
        headers: {
          origin: crossOriginClientOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: crossOriginClientOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows configured development origins through ServerConfig", () =>
    Effect.gen(function* () {
      const tailnetOrigin = "https://host.example.ts.net";
      yield* buildAppUnderTest({
        config: {
          devUrl: new URL(crossOriginClientOrigin),
          devAllowedOrigins: [tailnetOrigin],
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* fetchEffect(sessionUrl, {
        method: "OPTIONS",
        headers: {
          origin: tailnetOrigin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: tailnetOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const desktopOrigin of ["t3code://app", "t3code-dev://app"]) {
    it.effect(`allows credentialed preflights from ${desktopOrigin} in development`, () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: { devUrl: new URL(crossOriginClientOrigin) },
        });

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const response = yield* fetchEffect(sessionUrl, {
          method: "OPTIONS",
          headers: {
            origin: desktopOrigin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "content-type",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers, {
          origin: desktopOrigin,
          credentials: true,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("includes CORS headers on remote websocket-ticket auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
      const response = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          origin: crossOriginClientOrigin,
        },
      });
      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly code?: string;
        readonly reason?: string;
        readonly traceId?: string;
      }>(response);

      assert.equal(response.status, 401);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.equal(body._tag, "EnvironmentAuthInvalidError");
      assert.equal(body.code, "auth_invalid");
      assert.equal(body.reason, "missing_credential");
      assert.equal(typeof body.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly expiresAt: string;
      };

      assert.equal(response.status, 200);
      assert.equal(typeof body.credential, "string");
      assert.isTrue(body.credential.length > 0);
      assert.equal(typeof body.expiresAt, "string");

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(bootstrapResult.response.status, 200);

      const reusedResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(reusedResult.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues pairing credentials for bearer sessions with access management scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${bearerToken}`,
        },
        body: yield* HttpBody.json({ label: "Hosted web" }),
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly label?: string;
      };

      assert.equal(response.status, 200);
      assert.isTrue(body.credential.length > 0);
      assert.equal(body.label, "Hosted web");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credentials with an empty scope grant", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({ scopes: [] }),
      });
      const body = (yield* response.json) as {
        readonly code: string;
        readonly reason: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "invalid_request");
      assert.equal(body.reason, "invalid_scope");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unauthenticated pairing credential requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        body: yield* HttpBody.json({}),
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns only pairing metadata to access-read HTTP sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "access:read",
      });
      assert.equal(reader.response.status, 200);
      assert.equal(reader.body.scope, "access:read");
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { cookie: yield* getAuthenticatedSessionCookieHeader() },
        body: yield* HttpBody.json({ label: "Synthetic phone" }),
      });
      const created = (yield* createdResponse.json) as { id: string; credential: string };
      assert.equal(createdResponse.status, 200);
      const response = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
      });
      assert.equal(response.status, 200);
      const responseText = yield* response.text;
      assert.notInclude(responseText, '"credential"');
      assert.notInclude(responseText, created.credential);
      const links = yield* responseJsonEffect<
        ReadonlyArray<{
          readonly id: string;
          readonly label?: string;
          readonly scopes: ReadonlyArray<string>;
        }>
      >(response);
      const listed = links.find((link) => link.id === created.id);
      assert.isDefined(listed);
      assert.deepInclude(listed, {
        label: "Synthetic phone",
        scopes: [...AuthStandardClientScopes],
      });

      const unauthorizedCreate = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
        body: yield* HttpBody.json({}),
      });
      assert.equal(unauthorizedCreate.status, 403);
      const idExchange = yield* exchangeAccessToken(created.id, { scope: "terminal:operate" });
      assert.equal(idExchange.response.status, 401);
      const authorized = yield* exchangeAccessToken(created.credential, {
        scope: AuthStandardClientScopes.join(" "),
      });
      assert.equal(authorized.response.status, 200);
      assert.equal(authorized.body.scope, AuthStandardClientScopes.join(" "));
      const reused = yield* exchangeAccessToken(created.credential, { scope: "terminal:operate" });
      assert.equal(reused.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns only pairing metadata in access-read WebSocket snapshots and updates", () =>
    Effect.gen(function* () {
      const changesSubscribed = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        onPairingChangesSubscribed: Deferred.succeed(changesSubscribed, undefined).pipe(
          Effect.asVoid,
        ),
      });
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createLink = Effect.gen(function* () {
        const response = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: { cookie: ownerCookie },
          body: yield* HttpBody.json({}),
        });
        assert.equal(response.status, 200);
        return (yield* response.json) as { id: string; credential: string };
      });
      const initialLink = yield* createLink;
      const reader = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "access:read",
      });
      assert.equal(reader.body.scope, "access:read");
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${reader.body.access_token ?? ""}` },
      });
      assert.equal(ticketResponse.status, 200);
      const { ticket } = (yield* ticketResponse.json) as { ticket: string };
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticket)}`;
      const frames: string[] = [];
      yield* withWsRpcClient(
        wsUrl,
        (client) =>
          Effect.gen(function* () {
            const snapshotReceived = yield* Deferred.make<void>();
            const eventsFiber = yield* client.subscribeAuthAccess({}).pipe(
              Stream.tap((event) =>
                event.type === "snapshot"
                  ? Deferred.succeed(snapshotReceived, undefined)
                  : Effect.void,
              ),
              Stream.takeUntil((event) => event.type === "pairingLinkUpserted"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Deferred.await(snapshotReceived);
            yield* Deferred.await(changesSubscribed);
            const liveLink = yield* createLink;
            const events = yield* Fiber.join(eventsFiber);
            const snapshot = events.find((event) => event.type === "snapshot");
            const update = events.find((event) => event.type === "pairingLinkUpserted");
            assert.isDefined(snapshot);
            assert.isDefined(update);
            assert.isTrue(
              snapshot?.payload.pairingLinks.some((link) => link.id === initialLink.id),
            );
            assert.equal(update?.payload.id, liveLink.id);
            // Inspect the wire frames so client schema decoding cannot hide a leak.
            assert.notInclude(frames.join(""), '"credential"');
            assert.notInclude(frames.join(""), initialLink.credential);
            assert.notInclude(frames.join(""), liveLink.credential);
            const paired = yield* exchangeAccessToken(liveLink.credential, {
              scope: AuthStandardClientScopes.join(" "),
            });
            assert.equal(paired.response.status, 200);
          }),
        (frame) => frames.push(frame),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and revokes pairing links for access management sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string;
        readonly credential: string;
      };

      const listResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string;
      }>;

      const revokeResponse = yield* HttpClient.post("/api/auth/pairing-links/revoke", {
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: HttpBody.text(jsonRequestBody({ id: createdBody.id }), "application/json"),
      });
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

      assert.equal(createdResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokedBootstrap.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credential requests without access management scope", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
        body: yield* HttpBody.json({}),
      });
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string;
      };
      assert.equal(ownerResponse.status, 200);

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential);
      const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairedBody = (yield* pairedResponse.json) as {
        readonly _tag: string;
        readonly code: string;
        readonly requiredScope: string;
        readonly traceId: string;
      };

      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody._tag, "EnvironmentScopeRequiredError");
      assert.equal(pairedBody.code, "insufficient_scope");
      assert.equal(pairedBody.requiredScope, "access:write");
      assert.equal(typeof pairedBody.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists paired clients and revokes other sessions while keeping the administrator", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* fetchEffect(pairingTokenUrl, {
        method: "POST",
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: jsonRequestBody({
          label: "Julius iPhone",
        }),
      });
      const ownerPairingBody = yield* responseJsonEffect<{
        readonly credential: string;
        readonly label?: string;
      }>(ownerPairingResponse);
      assert.equal(ownerPairingResponse.status, 200);
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        },
      });
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
      assert.isDefined(pairedSessionCookie);

      const pairedSessionCookieHeader = pairedSessionCookie ?? "";
      const listBeforeResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsBefore = (yield* listBeforeResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly browser?: string;
        };
      }>;
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

      const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number;
      };

      const listAfterResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;

      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
        body: yield* HttpBody.json({}),
      });
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly _tag: string;
        readonly code: string;
        readonly reason: string;
        readonly traceId: string;
      };

      assert.equal(listBeforeResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Julius iPhone");
      assert.lengthOf(clientsBefore, 2);
      assert.isDefined(pairedSessionId);
      assert.isDefined(pairedClientBefore);
      assert.deepInclude(pairedClientBefore?.client, {
        label: "Julius iPhone",
        deviceType: "mobile",
        os: "iOS",
        browser: "Safari",
        ipAddress: "127.0.0.1",
      });
      assert.equal(revokeOthersResponse.status, 200);
      assert.equal(revokeOthersBody.revokedCount, 1);
      assert.equal(listAfterResponse.status, 200);
      assert.lengthOf(clientsAfter, 1);
      assert.equal(clientsAfter[0]?.current, true);
      assert.equal(pairedClientPairingResponse.status, 401);
      assert.equal(pairedClientPairingBody._tag, "EnvironmentAuthInvalidError");
      assert.equal(pairedClientPairingBody.code, "auth_invalid");
      assert.equal(pairedClientPairingBody.reason, "invalid_credential");
      assert.equal(typeof pairedClientPairingBody.traceId, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("separates access inventory reads from credential management writes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const issueScopedSession = Effect.fnUntraced(function* (
        scope: "access:read" | "access:write",
      ) {
        const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
          headers: {
            cookie: ownerCookie,
          },
          body: yield* HttpBody.json({ scopes: [scope] }),
        });
        assert.equal(pairingResponse.status, 200);
        const pairingBody = (yield* pairingResponse.json) as {
          readonly credential: string;
        };
        return yield* getAuthenticatedSessionCookieHeader(pairingBody.credential);
      });

      const readCookie = yield* issueScopedSession("access:read");
      const readListResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: readCookie,
        },
      });
      const readWriteResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: readCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const readWriteBody = (yield* readWriteResponse.json) as {
        readonly requiredScope: string;
      };

      const writeCookie = yield* issueScopedSession("access:write");
      const writeListResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: writeCookie,
        },
      });
      const writeListBody = (yield* writeListResponse.json) as {
        readonly requiredScope: string;
      };

      assert.equal(readListResponse.status, 200);
      assert.equal(readWriteResponse.status, 403);
      assert.equal(readWriteBody.requiredScope, "access:write");
      assert.equal(writeListResponse.status, 403);
      assert.equal(writeListBody.requiredScope, "access:read");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes an individual paired client session", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
        body: yield* HttpBody.json({}),
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
        pairingBody.credential,
      );

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
      assert.isDefined(pairedSessionId);

      const revokeResponse = yield* HttpClient.post("/api/auth/clients/revoke", {
        headers: {
          cookie: ownerCookie,
          "content-type": "application/json",
        },
        body: HttpBody.text(jsonRequestBody({ sessionId: pairedSessionId }), "application/json"),
      });
      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
        body: yield* HttpBody.json({}),
      });

      assert.equal(revokeResponse.status, 200);
      assert.equal(pairedClientPairingResponse.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows reusing the desktop bootstrap credential", () =>
    Effect.gen(function* () {
      // The desktop-bootstrap grant is delivered over trusted IPC at
      // backend launch and needs to stay claimable after a renderer
      // refresh, so it's intentionally reusable (unlike user-facing
      // one-time pairing credentials).
      yield* buildAppUnderTest();

      const first = yield* bootstrapBrowserSession();
      const second = yield* bootstrapBrowserSession();

      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake with a bootstrapped browser session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.isDefined(cookie);

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(response.auth.policy, "desktop-managed-local");
      assert.equal(response.shellResumeCompletionMarker, true);
      assert.isUndefined(response.shellRevealInFileManager);
      assert.isUndefined(response.shellRevealInFileManagerKind);
      assert.equal(response.threadResumeCompletionMarker, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("advertises the usable file manager and its reveal label", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
            resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
          },
        },
      });

      const { cookie } = yield* bootstrapBrowserSession();
      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.deepEqual(response.availableEditors, ["file-manager"]);
      assert.equal(response.shellRevealInFileManager, true);
      assert.equal(response.shellRevealInFileManagerKind, "file-explorer");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not block server config when editor discovery never resolves", () =>
    Effect.gen(function* () {
      const discoveryInterrupted = yield* Deferred.make<void>();
      const responseFiber = yield* resolveAvailableEditorsForConfig(
        Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
        ),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(5));

      const availableEditors = yield* Fiber.join(responseFiber);
      yield* Deferred.await(discoveryInterrupted);
      assert.deepEqual(availableEditors, []);
    }),
  );

  it.effect("does not block server config when file manager reveal discovery never resolves", () =>
    Effect.gen(function* () {
      const discoveryInterrupted = yield* Deferred.make<void>();
      const responseFiber = yield* resolveFileManagerRevealKindForConfig(
        Effect.never.pipe(
          Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
        ),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(5));

      const revealKind = yield* Fiber.join(responseFiber);
      yield* Deferred.await(discoveryInterrupted);
      assert.isUndefined(revealKind);
    }),
  );

  it.effect(
    "rejects websocket rpc handshake when a session token is only provided via query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?token=${encodeURIComponent(sessionToken)}`;

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );

        assert.equal(error._tag, "RpcClientError");
        assertInclude(String(error), "SocketOpenError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "accepts websocket rpc handshake with a dedicated websocket ticket in the query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");
        const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        });
        const wsTicketBody = yield* responseJsonEffect<{
          readonly ticket: string;
        }>(wsTicketResponse);
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies browser OTLP trace exports through the server", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "t3-web" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "effect",
                  version: "4.0.0-beta.43",
                },
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    parentSpanId: "3333333333333333",
                    name: "RpcClient.server.getSettings",
                    kind: 3,
                    startTimeUnixNano: "1000000",
                    endTimeUnixNano: "2000000",
                    attributes: [
                      {
                        key: "rpc.method",
                        value: { stringValue: "server.getSettings" },
                      },
                    ],
                    events: [
                      {
                        name: "http.request",
                        timeUnixNano: "1500000",
                        attributes: [
                          {
                            key: "http.status_code",
                            value: { intValue: "200" },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: "STATUS_CODE_OK",
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      };

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          origin: "http://localhost:5733",
        },
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(localTraceRecords, [
        {
          type: "otlp-span",
          name: "RpcClient.server.getSettings",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          parentSpanId: "3333333333333333",
          sampled: true,
          kind: "client",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          durationMs: 1,
          attributes: {
            "rpc.method": "server.getSettings",
          },
          resourceAttributes: {
            "service.name": "t3-web",
          },
          scope: {
            name: "effect",
            version: "4.0.0-beta.43",
            attributes: {},
          },
          events: [
            {
              name: "http.request",
              timeUnixNano: "1500000",
              attributes: {
                "http.status_code": "200",
              },
            },
          ],
          links: [],
          status: {
            code: "STATUS_CODE_OK",
          },
        },
      ]);
      assert.deepEqual(upstreamRequests, [
        {
          body: jsonRequestBody(payload),
          contentType: "application/json",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.options("/api/observability/v1/traces", {
        headers: {
          origin: "http://localhost:5733",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-methods"]), [
        "GET",
        "OPTIONS",
        "POST",
      ]);
      assert.deepEqual(splitHeaderTokens(response.headers["access-control-allow-headers"]), [
        "authorization",
        "b3",
        "content-type",
        "dpop",
        "traceparent",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores browser OTLP trace exports locally when no upstream collector is configured",
    () =>
      Effect.gen(function* () {
        const localTraceRecords: Array<unknown> = [];
        const payload = yield* makeBrowserOtlpPayload("client.test");
        const resourceSpan = payload.resourceSpans[0];
        const scopeSpan = resourceSpan?.scopeSpans[0];
        const span = scopeSpan?.spans[0];

        assert.notEqual(resourceSpan, undefined);
        assert.notEqual(scopeSpan, undefined);
        assert.notEqual(span, undefined);
        if (!resourceSpan || !scopeSpan || !span) {
          return;
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        assert.equal(localTraceRecords.length, 1);
        const record = localTraceRecords[0] as {
          readonly type: string;
          readonly name: string;
          readonly traceId: string;
          readonly spanId: string;
          readonly kind: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly events: ReadonlyArray<unknown>;
          readonly links: ReadonlyArray<unknown>;
          readonly scope: {
            readonly name?: string;
            readonly attributes: Readonly<Record<string, unknown>>;
          };
          readonly resourceAttributes: Readonly<Record<string, unknown>>;
          readonly status?: {
            readonly code?: string;
          };
        };

        assert.equal(record.type, "otlp-span");
        assert.equal(record.name, span.name);
        assert.equal(record.traceId, span.traceId);
        assert.equal(record.spanId, span.spanId);
        assert.equal(record.kind, "internal");
        assert.deepEqual(record.attributes, {});
        assert.deepEqual(record.events, []);
        assert.deepEqual(record.links, []);
        assert.equal(record.scope.name, scopeSpan.scope.name);
        assert.deepEqual(record.scope.attributes, {});
        assert.equal(record.resourceAttributes["service.name"], "t3-web");
        assert.equal(record.status?.code, String(span.status.code));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.removeKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            removeKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverRemoveKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads Codex thread feedback through websocket rpc", () =>
    Effect.gen(function* () {
      const input = {
        threadId: ThreadId.make("thread-feedback"),
        reason: "The agent stopped early.",
      };
      const uploadFeedback = vi.fn<ProviderService.ProviderService["Service"]["uploadFeedback"]>(
        () => Effect.succeed({ feedbackId: "codex-thread-feedback" }),
      );
      yield* buildAppUnderTest({
        layers: {
          providerService: { uploadFeedback },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.providerUploadFeedback](input)),
      );

      assert.deepStrictEqual(response, { feedbackId: "codex-thread-feedback" });
      assert.deepStrictEqual(uploadFeedback.mock.calls, [[input]]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads image bytes through a signed URL issued by websocket rpc", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            const rejected = yield* HttpClient.post(issued.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3]), "image/png"),
            });
            assert.equal(rejected.status, 400);

            const response = yield* HttpClient.post(issued.relativeUrl, {
              headers: { origin: crossOriginClientOrigin },
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });
            assert.equal(response.status, 204);
            assertBrowserApiCorsResponseHeaders(response.headers);

            const attachmentPath = path.join(config.attachmentsDir, `${issued.attachmentId}.png`);
            assert.isTrue(yield* fileSystem.exists(attachmentPath));

            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId });
            assert.isFalse(yield* fileSystem.exists(attachmentPath));

            const streamed = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "streamed.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            const streamedResponse = yield* HttpClient.post(streamed.relativeUrl, {
              body: HttpBody.stream(Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])), "image/png"),
            });
            assert.equal(streamedResponse.status, 204);
            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: streamed.attachmentId });

            const uploadedFile = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              type: "file",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 6,
            });
            const fileResponse = yield* HttpClient.post(uploadedFile.relativeUrl, {
              body: HttpBody.stream(
                Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
                "application/pdf",
              ),
            });
            assert.equal(fileResponse.status, 204);
            const uploadedFilePath = path.join(
              config.attachmentsDir,
              `${uploadedFile.attachmentId}.pdf`,
            );
            assert.isTrue(yield* fileSystem.exists(uploadedFilePath));

            // A mint that carries the attachment's display name and mime
            // serves a real download filename and Content-Type.
            const download = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "attachment",
                attachmentId: uploadedFile.attachmentId,
                fileName: "report.pdf",
                mimeType: "application/pdf",
              },
            });
            const downloadResponse = yield* HttpClient.get(download.relativeUrl);
            assert.equal(downloadResponse.status, 200);
            assert.equal(
              downloadResponse.headers["content-disposition"],
              'attachment; filename="report.pdf"',
            );
            assert.equal(downloadResponse.headers["content-type"], "application/pdf");

            // Old clients mint without name or mime and still get a download.
            const bareDownload = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "attachment", attachmentId: uploadedFile.attachmentId },
            });
            const bareResponse = yield* HttpClient.get(bareDownload.relativeUrl);
            assert.equal(bareResponse.status, 200);
            assert.equal(bareResponse.headers["content-disposition"], "attachment");
            assert.equal(bareResponse.headers["content-type"], "application/octet-stream");

            yield* client[WS_METHODS.attachmentsDelete]({
              attachmentId: uploadedFile.attachmentId,
            });
            assert.isFalse(yield* fileSystem.exists(uploadedFilePath));
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects an over-limit chunked upload through the route without hanging", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              type: "file",
              name: "big.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 6,
            });
            const NodeHttp = yield* Effect.promise(() => import("node:http"));
            const uploadUrl = new URL(issued.relativeUrl, yield* getHttpServerUrl());
            const status = yield* Effect.callback<number, Error>((resume) => {
              let completed = false;
              const complete = (result: Effect.Effect<number, Error>) => {
                if (completed) return;
                completed = true;
                resume(result);
              };
              const request = NodeHttp.request(
                uploadUrl,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/octet-stream",
                    "transfer-encoding": "chunked",
                  },
                },
                (response) => {
                  request.end();
                  response.resume();
                  response.once("end", () => complete(Effect.succeed(response.statusCode ?? 0)));
                  response.once("error", (error) => complete(Effect.fail(error)));
                },
              );
              request.once("error", (error) => complete(Effect.fail(error)));
              request.flushHeaders();
              request.write(new Uint8Array(4), () => {
                request.write(new Uint8Array(4));
              });

              return Effect.sync(() => request.destroy());
            });
            assert.equal(status, 400);
            assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps feedback errors structured across websocket rpc", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-feedback-failure");
      yield* buildAppUnderTest({
        layers: {
          providerService: {
            uploadFeedback: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "feedback/upload",
                  detail: "private provider detail",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.providerUploadFeedback]({ threadId }).pipe(Effect.flip),
        ),
      );

      assert.strictEqual(error._tag, "ProviderUploadFeedbackError");
      if (error._tag === "ProviderUploadFeedbackError") {
        assert.strictEqual(error.threadId, threadId);
        assert.strictEqual(error.message, `Failed to upload feedback for thread ${threadId}.`);
        assert.isDefined(error.cause);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("shares one preview automation broker across websocket sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const firstConnected = yield* Deferred.make<string>();
        const firstClosed = yield* Deferred.make<void>();
        const host = {
          clientId: "shared-preview-host",
          environmentId: testEnvironmentDescriptor.environmentId,
        } as const;

        yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(
            Stream.tap((event) =>
              event.type === "connected"
                ? Deferred.succeed(firstConnected, event.connectionId)
                : Effect.void,
            ),
            Stream.runDrain,
            Effect.ensuring(Deferred.succeed(firstClosed, undefined)),
          ),
        ).pipe(Effect.forkScoped);

        const firstConnectionId = yield* Deferred.await(firstConnected);
        const replacementEvent = yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(Stream.runHead),
        ).pipe(Effect.map(Option.getOrThrow));
        const firstStreamClosed = yield* Deferred.await(firstClosed).pipe(
          Effect.timeoutOption("2 seconds"),
        );

        assert.equal(replacementEvent.type, "connected");
        assert.notEqual(replacementEvent.connectionId, firstConnectionId);
        assert.isTrue(Option.isSome(firstStreamClosed));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      const failureMessage = String(result.failure);
      assertTrue(
        failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
      );
      assertTrue(
        failureMessage.includes("Unauthorized") ||
          failureMessage.includes("An error occurred during Open"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provider setup lets read-only clients observe installation but not change setup", () =>
    Effect.gen(function* () {
      let installStarts = 0;
      let authCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: {
            getInstance: (instanceId) =>
              Effect.succeed(
                instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
              ),
          },
          antigravityInstallation: {
            start: Effect.sync(() => {
              installStarts += 1;
              return providerSetupInstallState;
            }),
            changes: Stream.succeed(providerSetupInstallState),
          },
          providerAuth: {
            start: () =>
              Effect.sync(() => {
                authCalls += 1;
                return providerSetupAuthState;
              }),
            subscribe: () =>
              Stream.fromEffect(
                Effect.sync(() => {
                  authCalls += 1;
                  return providerSetupAuthState;
                }),
              ),
          },
        },
      });
      const token = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });
      assert.equal(token.response.status, 200);
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${token.body.access_token ?? ""}` },
      });
      const { ticket } = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticket)}`;
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
              instanceId: providerSetupInstanceId,
            }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
            assert.deepEqual(observed, providerSetupInstallState);
            const errors = [
              yield* client[WS_METHODS.providerInstallStart]({
                instanceId: providerSetupInstanceId,
              }).pipe(Effect.flip),
              yield* client[WS_METHODS.providerAuthStart]({
                instanceId: providerSetupInstanceId,
              }).pipe(Effect.flip),
              yield* client[WS_METHODS.providerAuthSubscribe]({
                instanceId: providerSetupInstanceId,
              }).pipe(Stream.runHead, Effect.flip),
            ];
            for (const error of errors) {
              assert.equal(error._tag, "EnvironmentAuthorizationError");
              if (error._tag === "EnvironmentAuthorizationError") {
                assert.equal(error.requiredScope, "orchestration:operate");
              }
            }
          }),
        ),
      );
      assert.equal(installStarts, 0);
      assert.equal(authCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provider setup binds private sign-in to the authenticated websocket session", () =>
    Effect.gen(function* () {
      const flowId = "private-sign-in-flow";
      const callbackUrl = "http://127.0.0.1:51234/?state=test-state&code=test-code";
      const waiting: ProviderAuthState = {
        ...providerSetupAuthState,
        phase: "waiting",
        flowId,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
        expiresAt: "2026-09-02T00:05:00.000Z",
      };
      const calls: Array<{
        readonly operation: string;
        readonly instanceId: ProviderInstanceId;
        readonly ownerSessionId: string;
      }> = [];
      const forwardedCallbacks: string[] = [];
      const logoutInstances: ProviderInstanceId[] = [];
      let flowOwner = "";
      yield* buildAppUnderTest({
        layers: {
          providerAuth: {
            start: (input, ownerSessionId) =>
              Effect.sync(() => {
                flowOwner = ownerSessionId;
                calls.push({ operation: "start", instanceId: input.instanceId, ownerSessionId });
                return waiting;
              }),
            subscribe: (input, ownerSessionId) =>
              Stream.fromEffect(
                Effect.sync(() => {
                  calls.push({
                    operation: "subscribe",
                    instanceId: input.instanceId,
                    ownerSessionId,
                  });
                  return ownerSessionId === flowOwner
                    ? waiting
                    : { ...waiting, flowId: null, authorizationUrl: null, expiresAt: null };
                }),
              ),
            complete: (input, ownerSessionId) =>
              Effect.gen(function* () {
                calls.push({ operation: "complete", instanceId: input.instanceId, ownerSessionId });
                if (ownerSessionId !== flowOwner) {
                  return yield* new ProviderSetupError({
                    instanceId: input.instanceId,
                    operation: "complete",
                    detail: "This sign-in belongs to another client.",
                  });
                }
                assert.equal(input.flowId, flowId);
                forwardedCallbacks.push(input.callbackUrl);
                return { ...waiting, phase: "verifying" as const, authorizationUrl: null };
              }),
            cancel: (input, ownerSessionId) =>
              Effect.sync(() => {
                assert.equal(input.flowId, flowId);
                calls.push({ operation: "cancel", instanceId: input.instanceId, ownerSessionId });
                return { ...providerSetupAuthState, phase: "cancelled" as const, flowId };
              }),
            logout: (input) =>
              Effect.sync(() => {
                logoutInstances.push(input.instanceId);
                return providerSetupAuthState;
              }),
          },
        },
      });
      const firstCookie = yield* getAuthenticatedSessionCookieHeader();
      const secondCookie = yield* getAuthenticatedSessionCookieHeader();
      const firstClients = yield* HttpClient.get("/api/auth/clients", {
        headers: { cookie: firstCookie },
      }).pipe(
        Effect.flatMap(
          responseJsonEffect<
            ReadonlyArray<{ readonly sessionId: string; readonly current: boolean }>
          >,
        ),
      );
      const secondClients = yield* HttpClient.get("/api/auth/clients", {
        headers: { cookie: secondCookie },
      }).pipe(
        Effect.flatMap(
          responseJsonEffect<
            ReadonlyArray<{ readonly sessionId: string; readonly current: boolean }>
          >,
        ),
      );
      const firstOwner = firstClients.find((session) => session.current)?.sessionId;
      const secondOwner = secondClients.find((session) => session.current)?.sessionId;
      assert.isString(firstOwner);
      assert.isString(secondOwner);
      assert.notEqual(firstOwner, secondOwner);
      const baseWsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const target = {
        instanceId: providerSetupInstanceId,
        ownerSessionId: "client-supplied-owner",
      };
      yield* Effect.scoped(
        withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, firstCookie), (client) =>
          Effect.gen(function* () {
            const started = yield* client[WS_METHODS.providerAuthStart](target);
            assert.equal(started.flowId, flowId);
            const ownState = yield* client[WS_METHODS.providerAuthSubscribe](target).pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            assert.equal(ownState.authorizationUrl, waiting.authorizationUrl);
            yield* Effect.scoped(
              withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, secondCookie), (otherClient) =>
                Effect.gen(function* () {
                  const otherState = yield* otherClient[WS_METHODS.providerAuthSubscribe](
                    target,
                  ).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
                  assert.isNull(otherState.authorizationUrl);
                  assert.isNull(otherState.flowId);
                  const forged = { ...target, ownerSessionId: firstOwner, flowId, callbackUrl };
                  const denied = yield* otherClient[WS_METHODS.providerAuthComplete](forged).pipe(
                    Effect.flip,
                  );
                  assert.equal(denied._tag, "ProviderSetupError");
                  assert.deepEqual(forwardedCallbacks, []);
                }),
              ),
            );
            const completed = yield* client[WS_METHODS.providerAuthComplete]({
              ...target,
              flowId,
              callbackUrl,
            });
            assert.equal(completed.phase, "verifying");
            const cancelled = yield* client[WS_METHODS.providerAuthCancel]({ ...target, flowId });
            assert.equal(cancelled.phase, "cancelled");
            const signedOut = yield* client[WS_METHODS.providerAuthLogout](target);
            assert.equal(signedOut.phase, "idle");
          }),
        ),
      );
      assert.deepEqual(forwardedCallbacks, [callbackUrl]);
      assert.deepEqual(logoutInstances, [providerSetupInstanceId]);
      assert.isTrue(calls.every((call) => call.instanceId === providerSetupInstanceId));
      assert.deepEqual(
        calls.map((call) => call.ownerSessionId),
        [firstOwner, firstOwner, secondOwner, secondOwner, firstOwner, firstOwner],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "provider setup routes installation operations and returns only safe typed errors",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let state = providerSetupInstallState;
        yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (instanceId) =>
                Effect.succeed(
                  instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
                ),
            },
            antigravityInstallation: {
              start: Effect.sync(() => {
                calls.push("start");
                return state;
              }),
              cancel: (operationId) =>
                Effect.gen(function* () {
                  calls.push(`cancel:${operationId}`);
                  if (operationId !== state.operationId) {
                    return yield* new AntigravityInstallationError({
                      operation: "cancel",
                      detail: "This installation is no longer running.",
                      cause: new Error("Private download diagnostics."),
                    });
                  }
                  state = { ...state, phase: "cancelled" };
                  return state;
                }),
              changes: Stream.fromEffect(Effect.sync(() => state)),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const unknownInstance = yield* client[WS_METHODS.providerInstallStart]({
                instanceId: ProviderInstanceId.make("unknown-instance"),
              }).pipe(Effect.flip);
              assert.equal(unknownInstance._tag, "ProviderSetupError");
              assert.deepEqual(calls, []);
              const started = yield* client[WS_METHODS.providerInstallStart]({
                instanceId: providerSetupInstanceId,
              });
              assert.deepEqual(started, providerSetupInstallState);
              const stale = yield* client[WS_METHODS.providerInstallCancel]({
                instanceId: providerSetupInstanceId,
                operationId: "old-operation",
              }).pipe(Effect.flip);
              assert.equal(stale._tag, "ProviderSetupError");
              if (stale._tag === "ProviderSetupError") {
                assert.equal(stale.instanceId, providerSetupInstanceId);
                assert.equal(stale.operation, "cancel");
                assert.equal(stale.detail, "This installation is no longer running.");
                assert.notProperty(stale, "cause");
              }
              const cancelled = yield* client[WS_METHODS.providerInstallCancel]({
                instanceId: providerSetupInstanceId,
                operationId: "install-operation",
              });
              assert.equal(cancelled.phase, "cancelled");
              const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
                instanceId: providerSetupInstanceId,
              }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
              assert.deepEqual(observed, cancelled);
            }),
          ),
        );
        assert.deepEqual(calls, ["start", "cancel:old-operation", "cancel:install-operation"]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providers = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(path.basename(first.config.observability.logsDirectoryPath), "logs");
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { keybindings: [], issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refreshes providers for each subscribeServerConfig connection", () =>
    Effect.gen(function* () {
      const refreshCalls = yield* Ref.make(0);
      const firstRefreshDone = yield* Deferred.make<void>();
      const secondRefreshDone = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            refresh: () =>
              Ref.updateAndGet(refreshCalls, (count) => count + 1).pipe(
                Effect.tap((count) =>
                  Deferred.succeed(
                    count === 1 ? firstRefreshDone : secondRefreshDone,
                    undefined,
                  ).pipe(Effect.ignore),
                ),
                Effect.as([]),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
            yield* Deferred.await(firstRefreshDone);
          }),
        ),
      );
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
            yield* Deferred.await(secondRefreshDone);
          }),
        ),
      );

      assert.equal(yield* Ref.get(refreshCalls), 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket resource telemetry through the subscription", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshot = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(Stream.runHead),
        ),
      );

      assertTrue(Option.isSome(snapshot));
      assert.equal(snapshot.value.processes.length, 0);
      assert.equal(snapshot.value.groups.backend.processCount, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // An already-shipped client decodes this stream against an event union
  // without environmentThemesUpdated, so an ungated emit would kill its whole
  // config subscription. Opting in is the only way to receive them.
  it.effect("subscribeServerConfig sends published themes to an opt-in subscriber", () =>
    Effect.gen(function* () {
      const themes = [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark" as const,
          canvas: "#1a1b26",
          accent: "#7aa2f7",
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          environmentTheme: {
            current: Effect.succeed(themes),
            streamChanges: Stream.succeed(themes),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({ environmentThemes: true }).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      // Not in the snapshot as well, or every opt-in client receives the same
      // array twice on every connect.
      if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
      assert.equal(second?.type, "environmentThemesUpdated");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeServerConfig withholds published themes from other subscribers", () =>
    Effect.gen(function* () {
      const themes = [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark" as const,
          canvas: "#1a1b26",
          accent: "#7aa2f7",
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          environmentTheme: {
            current: Effect.succeed(themes),
            streamChanges: Stream.succeed(themes),
          },
          providerRegistry: { streamChanges: Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(1), Stream.runCollect),
        ),
      );

      const first = Array.from(events)[0];
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const nextProviders = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(nextProviders),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.deepEqual(first.config.providers, []);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers: nextProviders },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: "2026-01-01T00:00:00.000Z", environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc projects.listEntries and projects.readFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-files-" });
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "index.ts"),
        "export const answer = 42;\n",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            listing: client[WS_METHODS.projectsListEntries]({ cwd: workspaceDir }),
            file: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "src/index.ts",
            }),
          }),
        ),
      );

      assert.isTrue(response.listing.entries.some((entry) => entry.path === "src/index.ts"));
      assert.deepEqual(response.file, {
        relativePath: "src/index.ts",
        contents: "export const answer = 42;\n",
        byteLength: 26,
        truncated: false,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-project-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ["src/tracked.ts"],
                truncated: false,
                freshness: {
                  source: "live-local",
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "ignored-search-target",
            limit: 10,
          }),
        ),
      );

      assert.equal(response.entries.length, 0);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("preserves structured workspace rpc failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-",
      });
      const outsideDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-outside-",
      });
      const outsideFile = path.join(outsideDir, "outside.txt");
      yield* fs.writeFileString(outsideFile, "outside\n");
      yield* fs.symlink(outsideFile, path.join(workspaceDir, "linked-outside.txt"));
      const resolvedOutsideFile = yield* fs.realPath(outsideFile);

      yield* buildAppUnderTest();

      const invalidWorkspace = path.join(workspaceDir, "missing-workspace");
      const missingBrowseParent = path.join(workspaceDir, "missing-browse");
      const sensitiveQuery = "authorization: Bearer secret-token";
      const wsUrl = yield* getWsServerUrl("/ws");
      const results = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            search: client[WS_METHODS.projectsSearchEntries]({
              cwd: invalidWorkspace,
              query: sensitiveQuery,
              limit: 10,
            }).pipe(Effect.result),
            list: client[WS_METHODS.projectsListEntries]({ cwd: invalidWorkspace }).pipe(
              Effect.result,
            ),
            read: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "linked-outside.txt",
            }).pipe(Effect.result),
            browse: client[WS_METHODS.filesystemBrowse]({
              cwd: workspaceDir,
              partialPath: "./missing-browse/child",
            }).pipe(Effect.result),
          }),
        ),
      );

      if (
        results.search._tag !== "Failure" ||
        results.search.failure._tag !== "ProjectSearchEntriesError"
      ) {
        assert.fail("Expected a ProjectSearchEntriesError");
      }
      const searchError = results.search.failure;
      assert.equal(
        searchError.message,
        `Failed to search workspace entries in '${invalidWorkspace}'.`,
      );
      assert.equal(searchError.cwd, invalidWorkspace);
      assert.equal(searchError.queryLength, sensitiveQuery.length);
      assert.notProperty(searchError, "query");
      assert.notInclude(searchError.message, "Bearer");
      assert.notInclude(searchError.message, "secret-token");
      assert.equal(searchError.limit, 10);
      assert.equal(searchError.failure, "workspace_root_not_found");
      assert.equal(searchError.normalizedCwd, invalidWorkspace);
      assert.isDefined(searchError.cause);

      if (
        results.list._tag !== "Failure" ||
        results.list.failure._tag !== "ProjectListEntriesError"
      ) {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const listError = results.list.failure;
      assert.equal(listError.message, `Failed to list workspace entries in '${invalidWorkspace}'.`);
      assert.equal(listError.cwd, invalidWorkspace);
      assert.equal(listError.failure, "workspace_root_not_found");
      assert.equal(listError.normalizedCwd, invalidWorkspace);
      assert.isDefined(listError.cause);

      if (results.read._tag !== "Failure" || results.read.failure._tag !== "ProjectReadFileError") {
        assert.fail("Expected a ProjectReadFileError");
      }
      const readError = results.read.failure;
      assert.equal(
        readError.message,
        `Failed to read workspace file 'linked-outside.txt' in '${workspaceDir}'.`,
      );
      assert.equal(readError.cwd, workspaceDir);
      assert.equal(readError.relativePath, "linked-outside.txt");
      assert.equal(readError.failure, "resolved_path_outside_root");
      assert.equal(readError.resolvedPath, resolvedOutsideFile);
      assert.isDefined(readError.cause);

      if (
        results.browse._tag !== "Failure" ||
        results.browse.failure._tag !== "FilesystemBrowseError"
      ) {
        assert.fail("Expected a FilesystemBrowseError");
      }
      const browseError = results.browse.failure;
      assert.equal(
        browseError.message,
        `Failed to browse filesystem path './missing-browse/child' from '${workspaceDir}'.`,
      );
      assert.equal(browseError.cwd, workspaceDir);
      assert.equal(browseError.partialPath, "./missing-browse/child");
      assert.equal(browseError.failure, "read_directory_failed");
      assert.equal(browseError.parentPath, missingBrowseParent);
      assert.isDefined(browseError.cause);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports workspace root stat failures without relabeling them as missing", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blockedRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-stat-error-",
      });
      const workspaceRoot = path.join(blockedRoot, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* fs.chmod(blockedRoot, 0o000);

      const result = yield* Effect.gen(function* () {
        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        return yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsListEntries]({ cwd: workspaceRoot }).pipe(Effect.result),
          ),
        );
      }).pipe(Effect.ensuring(fs.chmod(blockedRoot, 0o700).pipe(Effect.ignore)));

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const error = result.failure;
      assert.equal(error.failure, "workspace_root_stat_failed");
      assert.equal(error.normalizedCwd, workspaceRoot);
      assert.equal(error.detail, "validate-existing");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates a missing workspace root during websocket project.create dispatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-create-" });
      const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-missing-root"),
            projectId: ProjectId.make("project-create-missing-root"),
            title: "New Project",
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      const stat = yield* fs.stat(missingWorkspaceRoot);

      assert.isAtLeast(response.sequence, 0);
      assert.equal(stat.type, "Directory");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records thread analytics only after a client command succeeds", () =>
    Effect.gen(function* () {
      const effects: string[] = [];
      const analyticsProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];
      const failedCommandId = CommandId.make("cmd-thread-create-failed");

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              Effect.sync(() => {
                effects.push(`analytics:${event}`);
                analyticsProperties.push(properties);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => effects.push(`dispatch:${command.commandId}`)).pipe(
                Effect.flatMap(() =>
                  command.commandId === failedCommandId
                    ? Effect.fail(
                        new OrchestrationListenerCallbackError({
                          listener: "domain-event",
                          detail: "thread creation failed",
                        }),
                      )
                    : Effect.succeed({ sequence: 1 }),
                ),
              ),
          },
        },
      });

      const createThreadCommand = (commandId: CommandId, threadId: ThreadId) =>
        ({
          type: "thread.create",
          commandId,
          threadId,
          projectId: defaultProjectId,
          title: "Analytics test",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }) as const;

      const wsUrl = yield* getWsServerUrl(
        "/ws?clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=iOS&clientOsMajorVersion=18&clientDeviceModel=iPhone+15+Pro&connectionMethod=relay",
      );
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const failed = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              createThreadCommand(failedCommandId, ThreadId.make("thread-create-failed")),
            ).pipe(Effect.result);

            assert.equal(failed._tag, "Failure");
            assert.deepEqual(effects, [
              "analytics:client.connected",
              "dispatch:cmd-thread-create-failed",
            ]);

            const succeeded = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              createThreadCommand(
                CommandId.make("cmd-thread-create-succeeded"),
                ThreadId.make("thread-create-succeeded"),
              ),
            );

            assert.equal(succeeded.sequence, 1);
          }),
        ),
      );

      assert.deepEqual(effects, [
        "analytics:client.connected",
        "dispatch:cmd-thread-create-failed",
        "dispatch:cmd-thread-create-succeeded",
        "analytics:client.thread.started",
      ]);
      assert.deepEqual(analyticsProperties, [
        {
          surface: "mobile",
          appVersion: "1.2.3",
          clientAppVersion: "1.2.3",
          clientOs: "iOS",
          os: "iOS",
          clientDeviceType: "phone",
          osMajorVersion: 18,
          clientOsMajorVersion: 18,
          deviceModel: "iPhone 15 Pro",
          clientDeviceModel: "iPhone 15 Pro",
          connectionMethod: "relay",
        },
        {
          surface: "mobile",
          appVersion: "1.2.3",
          clientAppVersion: "1.2.3",
          clientOs: "iOS",
          os: "iOS",
          clientDeviceType: "phone",
          osMajorVersion: 18,
          clientOsMajorVersion: 18,
          deviceModel: "iPhone 15 Pro",
          clientDeviceModel: "iPhone 15 Pro",
          connectionMethod: "relay",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps telemetry separate for simultaneous clients", () =>
    Effect.gen(function* () {
      const analyticsEvents: Array<{
        event: string;
        properties: Readonly<Record<string, unknown>> | undefined;
      }> = [];

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              Effect.sync(() => analyticsEvents.push({ event, properties })),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 1 }),
          },
        },
      });

      const webUrl = yield* getWsServerUrl(
        "/ws?clientSurface=web&clientAppVersion=2.0.0&clientDeviceType=desktop&clientOs=Windows&clientWebDeployment=hosted&clientBrowser=Chrome&connectionMethod=direct",
      );
      const mobileUrl = yield* getWsServerUrl(
        "/ws?clientSurface=mobile&clientAppVersion=3.0.0&clientDeviceType=tablet&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+Tablet&connectionMethod=relay",
      );
      const turnCommand = (client: string) => ({
        type: "thread.turn.start" as const,
        commandId: CommandId.make(`cmd-${client}-turn`),
        threadId: ThreadId.make(`thread-${client}`),
        message: {
          messageId: MessageId.make(`message-${client}`),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* Effect.scoped(
        withWsRpcClient(webUrl, (webClient) =>
          withWsRpcClient(mobileUrl, (mobileClient) =>
            Effect.gen(function* () {
              yield* mobileClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("mobile"));
              yield* webClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("web"));
            }),
          ),
        ),
      );

      assert.deepEqual(
        analyticsEvents
          .filter(({ event }) => event === "client.turn.requested")
          .map(({ properties }) => properties),
        [
          {
            surface: "mobile",
            appVersion: "3.0.0",
            clientAppVersion: "3.0.0",
            clientOs: "Android",
            os: "Android",
            clientDeviceType: "tablet",
            osMajorVersion: 15,
            clientOsMajorVersion: 15,
            deviceModel: "Pixel Tablet",
            clientDeviceModel: "Pixel Tablet",
            connectionMethod: "relay",
          },
          {
            surface: "web",
            appVersion: "2.0.0",
            clientAppVersion: "2.0.0",
            clientOs: "Windows",
            clientDeviceType: "desktop",
            webDeployment: "hosted",
            clientBrowser: "Chrome",
            connectionMethod: "direct",
          },
        ],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores invalid client telemetry without rejecting the connection", () =>
    Effect.gen(function* () {
      const connectedProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              event === "client.connected"
                ? Effect.sync(() => connectedProperties.push(properties))
                : Effect.void,
          },
        },
      });

      const invalidUrl = yield* getWsServerUrl(
        "/ws?clientSurface=watch&clientDeviceType=television&clientOs=Plan9&clientWebDeployment=cdn&clientBrowser=&clientOsMajorVersion=-1&connectionMethod=teleport",
      );
      yield* Effect.scoped(
        withWsRpcClient(invalidUrl, (client) => client[WS_METHODS.serverGetSettings]({})),
      );

      assert.deepEqual(connectedProperties, [{}]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected a ProjectWriteFileError");
      }
      const writeError = result.failure;
      assert.equal(
        writeError.message,
        `Failed to write workspace file '../escape.txt' in '${workspaceDir}'.`,
      );
      assert.equal(writeError.cwd, workspaceDir);
      assert.equal(writeError.relativePath, "../escape.txt");
      assert.equal(writeError.failure, "workspace_path_outside_root");
      assert.isDefined(writeError.cause);
      assert.notProperty(writeError, "contents");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const externalLauncherError = new ExternalLauncherCommandNotFoundError({
        editor: "cursor",
        command: "cursor",
      });
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: () => Effect.fail(externalLauncherError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, externalLauncherError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          cwd: "/tmp/repo",
        },
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.succeed({
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
                isOnPullRequestHead: true,
              }),
          },
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                refName: "main",
                upstreamRef: "origin/main",
              }),
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", refName: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createRef: (input) => Effect.succeed({ refName: input.refName }),
            switchRef: (input) => Effect.succeed({ refName: input.refName }),
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
          },
          reviewService: {
            getDiffPreview: (input) =>
              Effect.succeed({
                cwd: input.cwd,
                generatedAt: DateTime.nowUnsafe(),
                sources: [
                  {
                    id: "working-tree",
                    kind: "working-tree",
                    title: "Dirty worktree",
                    baseRef: "HEAD",
                    headRef: null,
                    diff: "dirty-diff",
                    diffHash: "hash-dirty",
                    truncated: false,
                  },
                  {
                    id: "branch-range",
                    kind: "branch-range",
                    title: "Against main",
                    baseRef: "main",
                    headRef: "feature/demo",
                    diff: "base-diff",
                    diffHash: "hash-base",
                    truncated: false,
                  },
                ],
              }),
            getDiffFileContents: () =>
              Effect.succeed({
                oldContents: "before\n",
                newContents: "after\n",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(refreshedStatus.isRepo, true);

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: "/tmp/repo" })),
      );
      assert.equal(refs.refs[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateWorktree]({
            cwd: "/tmp/repo",
            refName: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.refName, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateRef]({
            cwd: "/tmp/repo",
            refName: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsSwitchRef]({
            cwd: "/tmp/repo",
            refName: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );

      const diffPreview = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffPreview]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(diffPreview.sources[0]?.diff, "dirty-diff");

      const diffFileContents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffFileContents]({
            cwd: "/tmp/repo",
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "README.md",
            newPath: "README.md",
          }),
        ),
      );
      assert.equal(diffFileContents.oldContents, "before\n");
      assert.equal(diffFileContents.newContents, "after\n");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.runStackedAction errors after refreshing git status", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "commit",
        command: "git commit",
        cwd: "/tmp/repo",
        detail: "nothing to commit",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/demo",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect, Effect.result),
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("completes websocket rpc git.pull before background git status refresh finishes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled" as const,
                refName: "main",
                upstreamRef: "origin/main",
              }),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.as({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

      assert.equal(result.status, "pulled");
      assertTrue(elapsedMs < 1_000);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "completes websocket rpc git.runStackedAction before background git status refresh finishes",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

        assertTrue(elapsedMs < 1_000);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "starts a background local git status refresh after a successful git.runStackedAction",
    () =>
      Effect.gen(function* () {
        const localRefreshStarted = yield* Deferred.make<void>();

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Deferred.succeed(localRefreshStarted, undefined).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.succeed({
                      isRepo: true,
                      hasPrimaryRemote: true,
                      isDefaultRef: false,
                      refName: "feature/demo",
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                  ),
                ),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );

        yield* Deferred.await(localRefreshStarted);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
            searchThreads: () =>
              Effect.succeed({
                matches: [
                  {
                    threadId: ThreadId.make("thread-1"),
                    projectId: ProjectId.make("project-a"),
                    source: "assistant",
                    snippet: "Search reached the final response.",
                    messageCreatedAt: now,
                  },
                ],
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-1"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const searchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.searchThreads]({
            query: "final response",
          }),
        ),
      );
      assert.deepEqual(searchResult.matches, [
        {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-a"),
          source: "assistant",
          snippet: "Search reached the final response.",
          messageCreatedAt: now,
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration shell snapshot errors", () =>
    Effect.gen(function* () {
      const projectionError = new PersistenceSqlError({
        operation: "ProjectionSnapshotQuery.getShellSnapshot:test",
        detail: "failed to read projection shell snapshot",
      });
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () => Effect.fail(projectionError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runCollect),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertTrue(result.failure.cause instanceof Error);
      assert.include(result.failure.cause.message, projectionError.message);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks an empty shell catch-up replay as synchronized when requested", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: () => Stream.empty,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const firstItem = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.runHead),
        ),
      );

      assert.deepEqual(Option.getOrThrow(firstItem), { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks a socket thread snapshot as synchronized when requested", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 1, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(items[1], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("buffers shell events published while the fallback snapshot loads", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const deletedEvent = {
        sequence: 2,
        eventId: EventId.make("event-shell-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.deleted",
        payload: {
          threadId: defaultThreadId,
          deletedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, deletedEvent);
                return {
                  snapshotSequence: 1,
                  projects: [],
                  threads: [makeDefaultOrchestrationThreadShell()],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "thread-removed");
      assert.deepEqual(items[2], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("buffers thread events published while the initial snapshot loads", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const messageEvent = {
        sequence: 2,
        eventId: EventId.make("event-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "First message",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, messageEvent);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 2);
      assert.equal(items[2]?.kind, "synchronized");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("coalesces buffered live tool updates to the latest state", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  makeLiveToolActivityEvent(2),
                  makeLiveToolActivityEvent(3),
                  makeLiveToolActivityEvent(4),
                ]);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 4);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("flushes more than one tool chunk before the synchronization marker", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  ...Array.from({ length: 512 }, (_, index) =>
                    makeLiveToolActivityEvent(index + 2),
                  ),
                  makeLiveToolActivityEvent(514, "tool.updated", {
                    toolCallId: "call-read",
                    title: "Reading server.test.ts",
                    path: "apps/server/src/server.test.ts",
                  }),
                ]);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(4), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(
        items.slice(1, 3).map((item) => {
          assert.equal(item?.kind, "event");
          if (item?.kind !== "event" || item.event.type !== "thread.activity-appended") {
            return null;
          }
          return {
            sequence: item.event.sequence,
            summary: item.event.payload.activity.summary,
            payload: item.event.payload.activity.payload,
          };
        }),
        [
          {
            sequence: 513,
            summary: "Editing app.ts",
            payload: {
              itemType: "file_change",
              title: "Editing app.ts",
              data: {
                files: [{ path: "src/app.ts" }],
                toolCallId: "call-edit",
              },
            },
          },
          {
            sequence: 514,
            summary: "Reading server.test.ts",
            payload: {
              itemType: "file_change",
              title: "Reading server.test.ts",
              data: {
                files: [{ path: "apps/server/src/server.test.ts" }],
                toolCallId: "call-read",
              },
            },
          },
        ],
      );
      assert.deepEqual(items[3], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("flushes a tool update before an interleaved message", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const messageEvent = {
        sequence: 3,
        eventId: EventId.make("event-interleaved-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-interleaved"),
          role: "assistant",
          text: "Still working",
          turnId: TurnId.make("turn-edit"),
          streaming: false,
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  makeLiveToolActivityEvent(2),
                  messageEvent,
                  makeLiveToolActivityEvent(4, "tool.completed"),
                ]);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(4), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(
        items
          .slice(1)
          .map((item) => (item.kind === "event" ? [item.event.sequence, item.event.type] : null)),
        [
          [2, "thread.activity-appended"],
          [3, "thread.message-sent"],
          [4, "thread.activity-appended"],
        ],
      );
      assert.equal(
        items[3]?.kind === "event" && items[3].event.type === "thread.activity-appended"
          ? items[3].event.payload.activity.kind
          : null,
        "tool.completed",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeThread sends a fresh snapshot instead of replaying a large gap", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // Head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 100_000, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      // Large gap => fresh thread snapshot, and the global replay never starts.
      assert.equal(first?.kind, "snapshot");
      if (first?.kind === "snapshot") {
        assert.equal(first.snapshot.thread.id, defaultThreadId);
        assert.equal(first.snapshot.snapshotSequence, 100_000);
      }
      assert.equal(second?.kind, "synchronized");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stops an overflowing thread producer without an ACK and replays the missing events",
    () =>
      Effect.gen(function* () {
        const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        const attached = yield* Deferred.make<void>();
        const detached = yield* Deferred.make<void>();
        const ackHeld = yield* Deferred.make<void>();
        const releaseAck = yield* Deferred.make<void>();
        const firstApplied = yield* Deferred.make<void>();
        const replayStarted = yield* Deferred.make<void>();
        const replayCalls: Array<{ afterSequence: number; limit: number | undefined }> = [];
        let headSequence = 0;
        let snapshotCalls = 0;
        const message = (sequence: number, text: string) =>
          ({
            sequence,
            eventId: EventId.make(`slow-thread-${sequence}`),
            aggregateKind: "thread",
            aggregateId: defaultThreadId,
            occurredAt: "2026-01-01T00:00:01.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: defaultThreadId,
              messageId: MessageId.make(`slow-message-${sequence}`),
              role: "assistant",
              text,
              turnId: TurnId.make("turn-edit"),
              streaming: false,
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          }) satisfies OrchestrationEvent;
        const events = [
          message(1, "a".repeat(4 * 1024 * 1024)),
          message(2, "b".repeat(4 * 1024 * 1024)),
          makeLiveToolActivityEvent(3, "tool.completed"),
          message(4, "Finished"),
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              latestSequence: Effect.sync(() => headSequence),
              streamDomainEvents: Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(liveEvents);
                  yield* Deferred.succeed(attached, undefined);
                  return Stream.fromSubscription(subscription);
                }),
              ).pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
              readEvents: (afterSequence, limit) => {
                replayCalls.push({ afterSequence, limit });
                const range = events.filter(
                  (event) => event.sequence > afterSequence && event.sequence <= headSequence,
                );
                return Stream.concat(
                  Stream.fromEffect(Deferred.succeed(replayStarted, undefined)).pipe(Stream.drain),
                  Stream.fromIterable(range),
                );
              },
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.sync(() => {
                  snapshotCalls += 1;
                  return Option.none();
                }),
              getEventReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) => {
                const range = events.filter(
                  (event) =>
                    event.sequence > fromSequenceExclusive && event.sequence <= toSequenceInclusive,
                );
                return Effect.succeed({
                  eventCount: range.length,
                  payloadBytes: range.reduce(
                    (bytes, event) => bytes + Buffer.byteLength(jsonRequestBody(event.payload)),
                    0,
                  ),
                });
              },
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* makeWsRpcClient.pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              let cursor = 0;
              const received: number[] = [];
              const attempt = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                afterSequence: cursor,
              }).pipe(
                Stream.tap((item) => {
                  if (item.kind !== "event") return Effect.void;
                  cursor = item.event.sequence;
                  received.push(cursor);
                  return Deferred.succeed(firstApplied, undefined);
                }),
                Stream.runDrain,
                Effect.result,
                Effect.forkScoped,
              );
              yield* Deferred.await(attached);
              yield* Deferred.await(replayStarted);
              headSequence = 1;
              yield* PubSub.publish(liveEvents, events[0]!);
              yield* Deferred.await(ackHeld);
              yield* Deferred.await(firstApplied);
              headSequence = 4;
              yield* PubSub.publishAll(liveEvents, events.slice(1));

              // This must finish while the server is still waiting for the first
              // batch's ACK. A failed output queue alone would leave PubSub live.
              yield* Deferred.await(detached);
              assert.equal(yield* PubSub.size(liveEvents), 0);
              assert.deepEqual(received, [1]);
              yield* Deferred.succeed(releaseAck, undefined);
              const result = yield* Fiber.join(attempt);
              assertTrue(result._tag === "Failure");
              assert.equal(result.failure._tag, "OrchestrationGetSnapshotError");

              const recovered = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                afterSequence: cursor,
                requestCompletionMarker: true,
              }).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
              );
              assert.deepEqual(
                recovered.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
                [2, 3, 4, "synchronized"],
              );
              const first = recovered[0];
              assertTrue(first?.kind === "event" && first.event.type === "thread.message-sent");
              assert.equal(first.event.payload.text, events[1]!.payload.text);
              const completed = recovered[1];
              assertTrue(
                completed?.kind === "event" && completed.event.type === "thread.activity-appended",
              );
              assert.equal(completed.event.payload.activity.kind, "tool.completed");
              assert.deepEqual(replayCalls, [
                { afterSequence: 0, limit: 0 },
                { afterSequence: 1, limit: 3 },
              ]);
              assert.equal(snapshotCalls, 0);
            }),
          ),
          Effect.provide(withFirstWsAckHeld(wsUrl, ackHeld, releaseAck)),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops an overflowing shell producer without an ACK and recovers deleted entries", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const detached = yield* Deferred.make<void>();
      const ackHeld = yield* Deferred.make<void>();
      const releaseAck = yield* Deferred.make<void>();
      let headSequence = 1;
      let snapshotCalls = 0;
      let replayCalls = 0;
      const thread = makeDefaultOrchestrationThreadShell();
      const project = makeDefaultOrchestrationReadModel().projects[0]!;
      const events: OrchestrationEvent[] = Array.from({ length: 1_001 }, (_, index) =>
        makeLiveToolActivityEvent(index + 2, "tool.completed"),
      );
      events.push(
        {
          ...events[0]!,
          sequence: 1_003,
          type: "thread.archived",
          payload: {
            threadId: defaultThreadId,
            archivedAt: "2026-01-01T00:00:02.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        },
        {
          ...events[0]!,
          sequence: 1_004,
          aggregateKind: "project",
          aggregateId: defaultProjectId,
          type: "project.deleted",
          payload: { projectId: defaultProjectId, deletedAt: "2026-01-01T00:00:02.000Z" },
        },
      );
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.sync(() => headSequence),
            streamDomainEvents: Stream.fromPubSub(liveEvents).pipe(
              Stream.ensuring(Deferred.succeed(detached, undefined)),
            ),
            readEvents: () => {
              replayCalls += 1;
              return Stream.empty;
            },
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.sync(() => {
                snapshotCalls += 1;
                return {
                  snapshotSequence: headSequence,
                  projects: headSequence === 1 ? [project] : [],
                  threads: headSequence === 1 ? [thread] : [],
                  updatedAt: "2026-01-01T00:00:02.000Z",
                };
              }),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* makeWsRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const received: OrchestrationShellStreamItem[] = [];
            const attempt = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
              Stream.tap((item) => Effect.sync(() => received.push(item))),
              Stream.runDrain,
              Effect.result,
              Effect.forkScoped,
            );
            yield* Deferred.await(ackHeld);
            headSequence = 1_004;
            yield* PubSub.publishAll(liveEvents, events);
            yield* Deferred.await(detached);
            assert.equal(yield* PubSub.size(liveEvents), 0);
            yield* Deferred.succeed(releaseAck, undefined);
            const result = yield* Fiber.join(attempt);
            assertTrue(result._tag === "Failure");
            assert.equal(result.failure._tag, "OrchestrationGetSnapshotError");
            assert.equal(received.length, 1);
            const initial = received[0];
            assertTrue(initial?.kind === "snapshot");
            assert.equal(initial.snapshot.threads.length, 1);

            const recovered = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              afterSequence: initial.snapshot.snapshotSequence,
              requestCompletionMarker: true,
            }).pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            );
            const snapshot = recovered[0];
            assertTrue(snapshot?.kind === "snapshot");
            assert.equal(snapshot.snapshot.snapshotSequence, 1_004);
            assert.deepEqual(snapshot.snapshot.projects, []);
            assert.deepEqual(snapshot.snapshot.threads, []);
            assert.deepEqual(recovered[1], { kind: "synchronized" });
            assert.equal(snapshotCalls, 2);
            assert.equal(replayCalls, 0);
          }),
        ),
        Effect.provide(withFirstWsAckHeld(wsUrl, ackHeld, releaseAck)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 10,
          }).pipe(Stream.runHead),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread bounds catch-up replay to the captured head", () =>
    Effect.gen(function* () {
      let replayLimit: number | undefined;
      const now = "2026-01-01T00:00:00.000Z";
      const messageEvent = {
        sequence: 3,
        eventId: EventId.make("event-replay-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-replay"),
          role: "user",
          text: "Replayed message",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(50),
            readEvents: (_afterSequence, limit) => {
              replayLimit = limit;
              return Stream.make(messageEvent);
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      assert.equal(first?.kind, "event");
      assert.equal(first?.kind === "event" ? first.event.sequence : null, 3);
      assert.equal(second?.kind, "synchronized");
      // The replay is bounded to the head captured before the read, not
      // Number.MAX_SAFE_INTEGER.
      assert.equal(replayLimit, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell sends a fresh snapshot instead of replaying a large gap", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const snapshotThreadId = ThreadId.make("thread-from-snapshot");
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // Head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {
                  sequence: 1,
                  eventId: EventId.make("event-should-not-be-read"),
                  aggregateKind: "thread",
                  aggregateId: snapshotThreadId,
                  occurredAt: now,
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: "thread.created",
                  payload: {} as never,
                } satisfies OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 100_000,
                projects: [],
                threads: [makeDefaultOrchestrationThreadShell({ id: snapshotThreadId })],
                updatedAt: now,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      // Large gap => fresh snapshot, and the unbounded replay is never started.
      assert.equal(first?.kind, "snapshot");
      if (first?.kind === "snapshot") {
        assert.equal(first.snapshot.threads[0]?.id, snapshotThreadId);
      }
      assert.equal(second?.kind, "synchronized");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscriptions snapshot instead of decoding an oversized replay range", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      let replayStatsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const shell = makeDefaultOrchestrationThreadShell({ id: thread.id });

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getEventReplayStats: () =>
              Effect.sync(() => {
                replayStatsCalls += 1;
                return { eventCount: 5, payloadBytes: 8 * 1024 * 1024 + 1 };
              }),
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                projects: [],
                threads: [shell],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const threadItems = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: thread.id,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );
      const shellItems = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(threadItems[0]?.kind, "snapshot");
      assert.equal(threadItems[1]?.kind, "synchronized");
      assert.equal(shellItems[0]?.kind, "snapshot");
      assert.equal(shellItems[1]?.kind, "synchronized");
      assert.equal(replayStatsCalls, 2);
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                projects: [],
                threads: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 10 }).pipe(
            Stream.runHead,
          ),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces a per-thread burst without stalling other threads", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-busy");
      const newThreadId = ThreadId.make("thread-new");
      const now = "2026-01-01T00:00:00.000Z";
      const shellFetches: Array<string> = [];
      let replayLimit: number | undefined;

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(50),
            // A burst of message-sent deltas for the busy thread, plus one
            // thread.created for a different thread, all within one batch.
            readEvents: (_afterSequence, limit) => {
              replayLimit = limit;
              return Stream.fromIterable([
                ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
                createdEvent,
              ]);
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      );

      const collected = Array.from(items);
      const upsertedIds = collected.flatMap((item) =>
        item.kind === "thread-upserted" ? [item.thread.id] : [],
      );
      // Both threads surface, and the busy thread's 20-event burst collapses to
      // a single shell refetch (not 20). The new thread is not stuck behind it.
      assert.include(upsertedIds, busyThreadId);
      assert.include(upsertedIds, newThreadId);
      assert.equal(collected[2]?.kind, "synchronized");
      assert.equal(shellFetches.filter((id) => id === busyThreadId).length, 1);
      assert.equal(replayLimit, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces live bursts after the synchronization marker", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-live-busy");
      const newThreadId = ThreadId.make("thread-live-new");
      const now = "2026-01-01T00:00:00.000Z";
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const synchronized = yield* Deferred.make<void>();
      const shellFetches: Array<string> = [];
      const observedLiveThreadIds = new Set<string>();

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-live-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-live-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        Effect.gen(function* () {
          const itemsFiber = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(
              Stream.tap((item) =>
                item.kind === "synchronized"
                  ? Deferred.succeed(synchronized, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Stream.takeUntil((item) => {
                if (item.kind === "thread-upserted") {
                  observedLiveThreadIds.add(item.thread.id);
                }
                return (
                  observedLiveThreadIds.has(busyThreadId) && observedLiveThreadIds.has(newThreadId)
                );
              }),
              Stream.runCollect,
            ),
          ).pipe(Effect.forkScoped);

          yield* Deferred.await(synchronized);
          for (const event of [
            ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
            createdEvent,
          ]) {
            yield* PubSub.publish(liveEvents, event);
          }

          return yield* Fiber.join(itemsFiber);
        }),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "synchronized");
      const liveUpsertedIds = Array.from(items)
        .slice(2)
        .flatMap((item) => (item.kind === "thread-upserted" ? [item.thread.id] : []));
      assert.include(liveUpsertedIds, busyThreadId);
      assert.include(liveUpsertedIds, newThreadId);
      assert.isBelow(shellFetches.filter((id) => id === busyThreadId).length, 20);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeShell coalescing still emits a removal for a deleted thread", () =>
    Effect.gen(function* () {
      const goneThreadId = ThreadId.make("thread-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeThreadEvent = (
        sequence: number,
        type: "thread.deleted" | "thread.message-sent",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: goneThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload: type === "thread.deleted" ? { threadId: goneThreadId, deletedAt: now } : {},
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            // A thread.deleted followed, within the same coalescing window, by a
            // later refetchable event for the same thread. The later event wins
            // coalescing; its shell refetch returns none (the row is gone), which
            // must still surface a removal rather than be swallowed.
            readEvents: () =>
              Stream.fromIterable([
                makeThreadEvent(1, "thread.deleted"),
                makeThreadEvent(2, "thread.message-sent"),
              ]),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-removed");
      assert.equal(first?.kind === "thread-removed" ? first.threadId : null, goneThreadId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell retries a transient shell projection refetch failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-transient-refetch");
      const now = "2026-01-01T00:00:00.000Z";
      let attempts = 0;

      const event: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.make("event-transient-refetch"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(1),
            readEvents: () => Stream.make(event),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: "test.shell-refetch",
                        detail: "transient failure",
                      }),
                    )
                  : Effect.succeed(
                      Option.some(makeDefaultOrchestrationThreadShell({ id: threadId })),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-upserted");
      assert.equal(first?.kind === "thread-upserted" ? first.thread.id : null, threadId);
      assert.equal(attempts, 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalescing still removes a project after a trailing update", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeProjectEvent = (
        sequence: number,
        type: "project.deleted" | "project.meta-updated",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-project-${sequence}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload:
            type === "project.deleted"
              ? { projectId, deletedAt: now }
              : { projectId, title: "Still deleted", updatedAt: now },
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: () =>
              Stream.fromIterable([
                makeProjectEvent(1, "project.deleted"),
                makeProjectEvent(2, "project.meta-updated"),
              ]),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "project-removed");
      assert.equal(first?.kind === "project-removed" ? first.projectId : null, projectId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops the provider session and closes thread terminals after archive", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      const sessionStopCommand = dispatchedCommands[1];
      assert.equal(sessionStopCommand?.type, "thread.session.stop");
      if (sessionStopCommand?.type === "thread.session.stop") {
        assert.equal(sessionStopCommand.threadId, threadId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("checks session status before archiving removes the thread from active lookups", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-precheck");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";
      let archived = false;

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                if (command.type === "thread.archive") {
                  archived = true;
                }
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.sync(() => {
                effects.push(`query:thread-shell:${archived ? "archived" : "active"}`);
                return archived
                  ? Option.none()
                  : Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        updatedAt: now,
                        session: {
                          threadId,
                          status: "ready",
                          providerName: "claudeAgent",
                          runtimeMode: "full-access",
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: now,
                        },
                      }),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-precheck"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "query:thread-shell:active",
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives without dispatching session stop when the thread has no session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-no-session");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, session: null })),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-no-session"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "archives without dispatching session stop when the thread session is already stopped",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-archive-stopped-session");
        const effects: string[] = [];
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const now = "2026-01-01T00:00:00.000Z";

        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              close: (input) =>
                Effect.sync(() => {
                  effects.push(`terminal.close:${input.threadId}`);
                }),
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  effects.push(`dispatch:${command.type}`);
                  return { sequence: dispatchedCommands.length };
                }),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(
                    makeDefaultOrchestrationThreadShell({
                      id: threadId,
                      updatedAt: now,
                      session: {
                        threadId,
                        status: "stopped",
                        providerName: "claudeAgent",
                        runtimeMode: "full-access",
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: now,
                      },
                    }),
                  ),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const dispatchResult = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.archive",
              commandId: CommandId.make("cmd-thread-archive-stopped-session"),
              threadId,
            }),
          ),
        );

        assert.equal(dispatchResult.sequence, 1);
        assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.archive"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("leaves settle cleanup to the event reactor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-settle");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.settle",
            commandId: CommandId.make("cmd-thread-settle"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.settle"]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.settle"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("forwards the friendly blocked-settlement message over websocket rpc", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-settle-blocked");
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: () => Effect.fail(new OrchestrationThreadSettleBlockedError({ threadId })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.settle",
            commandId: CommandId.make("cmd-thread-settle-blocked"),
            threadId,
          }),
        ).pipe(Effect.flip),
      );

      assert.equal(error._tag, "OrchestrationDispatchCommandError");
      assert.equal(
        error.message,
        "This thread still needs attention. Resolve or interrupt it first, then try again.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-failure");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "simulated archive stop failure",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-failure"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop defects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-defect");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.die(new Error("simulated archive stop defect"));
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-defect"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps first-send worktree turns on the server before dispatching turn start",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const bootstrapGitOperations: string[] = [];
        const refreshStatus = vi.fn((_: string) =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "t3code/bootstrap-refName",
            hasWorkingTreeChanges: false,
            workingTree: {
              files: [],
              insertions: 0,
              deletions: 0,
            },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
        );
        const remoteExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("remote-exists");
              return true;
            }),
        );
        const fetchRemote = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("fetch");
            }),
        );
        const remoteBranchExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("remote-branch-exists");
              return true;
            }),
        );
        const fetchedOriginCommit = "0123456789abcdef0123456789abcdef01234567";
        const resolveRemoteTrackingCommit = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("resolve-remote-commit");
              return {
                commitSha: fetchedOriginCommit,
                remoteRefName: "origin/main",
              };
            }),
        );
        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("create-worktree");
              return {
                worktree: {
                  refName: "t3code/bootstrap-refName",
                  path: "/tmp/bootstrap-worktree",
                },
              };
            }),
        );
        const runForThread = vi.fn(
          (
            _: Parameters<
              ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
            >[0],
          ) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-setup",
              cwd: "/tmp/bootstrap-worktree",
            }),
        );

        yield* buildAppUnderTest({
          layers: {
            gitVcsDriver: {
              remoteExists,
              fetchRemote,
              remoteBranchExists,
              resolveRemoteTrackingCommit,
              createWorktree,
            },
            vcsStatusBroadcaster: {
              refreshStatus,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = "2026-01-01T00:00:00.000Z";
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start"),
              threadId: ThreadId.make("thread-bootstrap"),
              message: {
                messageId: MessageId.make("msg-bootstrap"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-refName",
                  startFromOrigin: true,
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 5);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          [
            "thread.create",
            "thread.meta.update",
            "thread.activity.append",
            "thread.activity.append",
            "thread.turn.start",
          ],
        );
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: fetchedOriginCommit,
          newRefName: "t3code/bootstrap-refName",
          baseRefName: "main",
          path: null,
        });
        assert.deepEqual(fetchRemote.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
        });
        assert.deepEqual(remoteBranchExists.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
          refName: "main",
        });
        assert.deepEqual(resolveRemoteTrackingCommit.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: "main",
          fallbackRemoteName: "origin",
        });
        assert.deepEqual(bootstrapGitOperations, [
          "remote-exists",
          "fetch",
          "remote-branch-exists",
          "resolve-remote-commit",
          "create-worktree",
        ]);
        assert.deepEqual(runForThread.mock.calls[0]?.[0], {
          threadId: ThreadId.make("thread-bootstrap"),
          projectId: defaultProjectId,
          projectCwd: "/tmp/project",
          worktreePath: "/tmp/bootstrap-worktree",
        });
        assert.deepEqual(refreshStatus.mock.calls[0]?.[0], "/tmp/bootstrap-worktree");

        const setupActivities = dispatchedCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
            command.type === "thread.activity.append",
        );
        assert.deepEqual(
          setupActivities.map((command) => command.activity.kind),
          ["setup-script.requested", "setup-script.started"],
        );
        const finalCommand = dispatchedCommands[4];
        assertTrue(finalCommand?.type === "thread.turn.start");
        if (finalCommand?.type === "thread.turn.start") {
          assert.equal(finalCommand.bootstrap, undefined);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    { caseName: "the origin remote is missing", hasOrigin: false },
    { caseName: "the base branch exists only locally", hasOrigin: true },
  ])("falls back to the local base branch when $caseName", ({ hasOrigin }) =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const remoteExists = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>[0]) =>
          Effect.succeed(hasOrigin),
      );
      const fetchRemote = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>[0]) => Effect.void,
      );
      const resolveRemoteTrackingCommit = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]>[0]) =>
          Effect.succeed({
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            remoteRefName: "origin/main",
          }),
      );
      const remoteBranchExists = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"]>[0]) =>
          Effect.succeed(false),
      );
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "t3code/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            remoteExists,
            fetchRemote,
            remoteBranchExists,
            resolveRemoteTrackingCommit,
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-no-origin"),
            threadId: ThreadId.make("thread-bootstrap-no-origin"),
            message: {
              messageId: MessageId.make("msg-bootstrap-no-origin"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
                startFromOrigin: true,
              },
            },
            createdAt,
          }),
        ),
      );

      assert.deepEqual(remoteExists.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        remoteName: "origin",
      });
      assert.equal(fetchRemote.mock.calls.length, hasOrigin ? 1 : 0);
      assert.equal(remoteBranchExists.mock.calls.length, hasOrigin ? 1 : 0);
      if (hasOrigin) {
        assert.deepEqual(remoteBranchExists.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
          refName: "main",
        });
      }
      assert.equal(resolveRemoteTrackingCommit.mock.calls.length, 0);
      assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        refName: "main",
        newRefName: "t3code/bootstrap-refName",
        baseRefName: "main",
        path: null,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records setup-script failures without aborting bootstrap turn start", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "t3code/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );
      const runForThread = vi.fn(
        (
          input: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
          >[0],
        ) =>
          Effect.fail(
            new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
              threadId: input.threadId,
              worktreePath: input.worktreePath,
              operation: "openTerminal",
              cause: { message: "pty unavailable" },
            }),
          ),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.activity.append", "thread.turn.start"],
      );
      const setupFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.equal(setupFailureActivity?.activity.kind, "setup-script.failed");
      assert.deepEqual(setupFailureActivity?.activity.payload, {
        detail: "pty unavailable",
        worktreePath: "/tmp/bootstrap-worktree",
      });
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not misattribute setup activity dispatch failures as setup launch failures", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "t3code/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );
      const runForThread = vi.fn(
        (
          _: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
          >[0],
        ) =>
          Effect.succeed({
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-setup",
            cwd: "/tmp/bootstrap-worktree",
          }),
      );
      let setupActivityAppendAttempt = 0;

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              if (
                command.type === "thread.activity.append" &&
                command.activity.kind.startsWith("setup-script.")
              ) {
                setupActivityAppendAttempt += 1;
                if (setupActivityAppendAttempt === 2) {
                  return Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "failed to append setup-script.started activity",
                    }),
                  );
                }
              }

              return Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              });
            },
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-activity-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-activity-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-activity-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.activity.append", "thread.turn.start"],
      );
      const setupActivities = dispatchedCommands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.deepEqual(
        setupActivities.map((command) => command.activity.kind),
        ["setup-script.requested"],
      );
      assertTrue(
        setupActivities.every((command) => command.activity.kind !== "setup-script.failed"),
      );
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up created bootstrap threads when worktree creation defects", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      const config = yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      let pendingAttachmentId: string | undefined;
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const upload = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            pendingAttachmentId = upload.attachmentId;
            const uploadResponse = yield* HttpClient.post(upload.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });
            assert.equal(uploadResponse.status, 204);

            return yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-defect"),
              threadId: ThreadId.make("thread-bootstrap-defect"),
              message: {
                messageId: MessageId.make("msg-bootstrap-defect"),
                role: "user",
                text: "hello",
                attachments: [
                  {
                    type: "image",
                    id: upload.attachmentId,
                    name: "screenshot.png",
                    mimeType: "image/png",
                    sizeBytes: 6,
                  },
                ],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-refName",
                },
                runSetupScript: false,
              },
              createdAt,
            });
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.strictEqual(result.failure.bootstrapThreadDisposition, "deleted");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
      assert.isDefined(pendingAttachmentId);
      assert.isTrue(
        yield* fileSystem.exists(path.join(config.attachmentsDir, `${pendingAttachmentId}.png`)),
      );
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), [
        `${pendingAttachmentId}.png`,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("drains deletion cleanup through the re-created thread event", () =>
    Effect.gen(function* () {
      // A draft retry reuses the thread id its failed bootstrap deleted. The
      // deletion reactor stops sessions and closes terminals by that id, so
      // both thread.create paths use the created event as a fence, then drain
      // cleanup before handing the new incarnation to resource-owning work.
      const trace: Array<string> = [];
      const drainRequested = yield* Deferred.make<void>();
      const cleanupDone = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        layers: {
          threadDeletionReactor: {
            drainThrough: (sequence) =>
              Effect.gen(function* () {
                trace.push(`drain:${sequence}`);
                yield* Deferred.succeed(drainRequested, undefined);
                yield* Deferred.await(cleanupDone);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                trace.push(command.type);
                return { sequence: trace.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-retry-after-delete");
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const directCreate = yield* Effect.forkChild(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("cmd-retry-create"),
                threadId,
                projectId: defaultProjectId,
                title: "Retry",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              }),
            );
            yield* Deferred.await(drainRequested);
            assert.deepEqual(trace, ["thread.create", "drain:1"]);
            yield* Deferred.succeed(cleanupDone, undefined);
            yield* Fiber.join(directCreate);
          }),
        ),
      );
      assert.deepEqual(trace, ["thread.create", "drain:1"]);

      // Cleanup is already released; the bootstrap path must still drain
      // between creating the thread and starting its turn.
      trace.length = 0;
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const bootstrapCreate = yield* Effect.forkChild(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make("cmd-retry-bootstrap"),
                threadId,
                message: {
                  messageId: MessageId.make("msg-retry-bootstrap"),
                  role: "user",
                  text: "hello",
                  attachments: [],
                },
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                bootstrap: {
                  createThread: {
                    projectId: defaultProjectId,
                    title: "Retry",
                    modelSelection: defaultModelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdAt,
                  },
                  runSetupScript: false,
                },
                createdAt,
              }),
            );
            yield* Fiber.join(bootstrapCreate);
          }),
        ),
      );
      assert.deepEqual(trace, ["thread.create", "drain:1", "thread.turn.start"]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not report a deleted bootstrap thread when cleanup fails", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              if (command.type === "thread.delete") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "thread cleanup exploded",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-cleanup-defect"),
            threadId: ThreadId.make("thread-bootstrap-cleanup-defect"),
            message: {
              messageId: MessageId.make("msg-bootstrap-cleanup-defect"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-refName",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.strictEqual(result.failure.bootstrapThreadDisposition, undefined);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Primary",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});

it.live(
  "reports thread HTTP and WebSocket transfer budgets",
  () =>
    Effect.gen(function* () {
      const providers = [
        ProviderDriverKind.make("codex"),
        ProviderDriverKind.make("claudeAgent"),
      ] as const;

      const runs = yield* Effect.forEach(
        providers,
        (provider) => {
          // One counter for the orchestration runtime and the HTTP/WS handlers,
          // so reactor writes and subscription reads land in the same total.
          const sqlCounter = makeSqlStatementCounter();
          return Effect.acquireUseRelease(
            makeOrchestrationIntegrationHarness({ provider, tracer: sqlCounter.tracer }),
            (harness) =>
              Effect.gen(function* () {
                yield* seedTransferBudgetHistory(harness, provider);
                yield* buildAppUnderTest({
                  layers: {
                    orchestrationEngine: harness.engine,
                    projectionSnapshotQuery: harness.snapshotQuery,
                  },
                });

                const baseUrl = yield* getHttpServerUrl();
                const cookie = yield* getAuthenticatedSessionCookieHeader();
                const wsUrl = baseUrl.replace(/^http:/, "ws:") + "/ws";

                return yield* Effect.scoped(
                  Effect.gen(function* () {
                    const threadSnapshot = yield* measureHttpGet({
                      url: `${baseUrl}/api/orchestration/threads/${TRANSFER_THREAD_ID}`,
                      headers: { cookie },
                    });
                    assert.equal(threadSnapshot.status, 200);
                    assert.equal(threadSnapshot.contentEncoding, "gzip");
                    const decodedThread = yield* decodeTransferThreadSnapshot(
                      Buffer.from(threadSnapshot.decodedBody).toString("utf8"),
                    );
                    assert.equal(
                      decodedThread.thread.messages.length,
                      TRANSFER_HISTORY_TURN_COUNT * 2,
                    );
                    const shellSnapshot = yield* measureHttpGet({
                      url: `${baseUrl}/api/orchestration/shell`,
                      headers: { cookie },
                    });
                    assert.equal(shellSnapshot.status, 200);
                    const decodedShell = yield* decodeTransferShellSnapshot(
                      Buffer.from(shellSnapshot.decodedBody).toString("utf8"),
                    );
                    assert.equal(decodedShell.threads.length, 1);

                    // Three sockets, the way real installs look: the capped
                    // thread-only client, a shell-only socket that isolates the
                    // sidebar cost, and a second device holding both.
                    const threadClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                    const shellClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                    const secondClient = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                    assert.include(
                      threadClient.recorder.negotiatedExtensions(),
                      "permessage-deflate",
                    );

                    const threadItems = yield* subscribeThreadItems(
                      threadClient,
                      decodedThread.snapshotSequence,
                    );
                    const shellItems = yield* subscribeShellItems(
                      shellClient,
                      decodedShell.snapshotSequence,
                    );
                    const secondThreadItems = yield* subscribeThreadItems(
                      secondClient,
                      decodedThread.snapshotSequence,
                    );
                    const secondShellItems = yield* subscribeShellItems(
                      secondClient,
                      decodedShell.snapshotSequence,
                    );
                    assert.equal(
                      yield* awaitSubscriptionSynchronized(
                        threadItems,
                        `${provider} thread subscription to synchronize`,
                      ),
                      "replay",
                    );
                    assert.equal(
                      yield* awaitSubscriptionSynchronized(
                        shellItems,
                        `${provider} shell subscription to synchronize`,
                      ),
                      "replay",
                    );
                    assert.equal(
                      yield* awaitSubscriptionSynchronized(
                        secondThreadItems,
                        `${provider} second client thread subscription to synchronize`,
                      ),
                      "replay",
                    );
                    assert.equal(
                      yield* awaitSubscriptionSynchronized(
                        secondShellItems,
                        `${provider} second client shell subscription to synchronize`,
                      ),
                      "replay",
                    );

                    yield* queueMeasuredTransferTurn(harness, provider);
                    const turnStartTotals = threadClient.recorder.totals();
                    const shellTurnStartTotals = shellClient.recorder.totals();
                    const secondTurnStartTotals = secondClient.recorder.totals();
                    const turnStartSqlStatements = sqlCounter.count();
                    yield* threadClient.client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                      type: "thread.turn.start",
                      commandId: CommandId.make(`transfer:${provider}:measured-turn`),
                      threadId: TRANSFER_THREAD_ID,
                      message: {
                        messageId: MessageId.make("transfer-user-measured"),
                        role: "user",
                        text: "Measure the client-bound transfer for this turn.",
                        attachments: [],
                      },
                      modelSelection: transferModelSelection(provider),
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      createdAt: TRANSFER_MEASURED_TURN_CREATED_AT,
                    });
                    yield* waitForTurnQuiesced(harness, TRANSFER_MEASURED_TURN_INDEX + 1);
                    const finalSequences = yield* harness.engine
                      .readEvents(decodedThread.snapshotSequence, 10_000)
                      .pipe(
                        Stream.runFold(
                          () => ({
                            detail: decodedThread.snapshotSequence,
                            aggregate: decodedShell.snapshotSequence,
                          }),
                          (sequences, event) =>
                            event.aggregateId !== TRANSFER_THREAD_ID
                              ? sequences
                              : {
                                  detail: isThreadDetailEvent(event)
                                    ? Math.max(sequences.detail, event.sequence)
                                    : sequences.detail,
                                  aggregate: Math.max(sequences.aggregate, event.sequence),
                                },
                        ),
                      );
                    const finalThreadSequence = finalSequences.detail;
                    assert.isAbove(finalThreadSequence, decodedThread.snapshotSequence);

                    const reachedFinalThreadEvent = (item: OrchestrationThreadStreamItem) =>
                      item.kind === "event" && item.event.sequence === finalThreadSequence;
                    // Shell items carry the sequence of the latest coalesced
                    // event for the thread, so the last one lands at or past
                    // the final thread event.
                    const reachedFinalShellEvent = (item: OrchestrationShellStreamItem) =>
                      item.kind === "thread-upserted" && item.sequence >= finalSequences.aggregate;
                    yield* collectQueueUntil(
                      threadItems,
                      reachedFinalThreadEvent,
                      `${provider} thread stream to reach sequence ${finalThreadSequence}`,
                    );
                    yield* collectQueueUntil(
                      secondThreadItems,
                      reachedFinalThreadEvent,
                      `${provider} second client thread stream to reach sequence ${finalThreadSequence}`,
                    );
                    yield* collectQueueUntil(
                      shellItems,
                      reachedFinalShellEvent,
                      `${provider} shell stream to reach sequence ${finalSequences.aggregate}`,
                    );
                    yield* collectQueueUntil(
                      secondShellItems,
                      reachedFinalShellEvent,
                      `${provider} second client shell stream to reach sequence ${finalSequences.aggregate}`,
                    );
                    const measuredTurnWebSocket = transferDelta(
                      turnStartTotals,
                      threadClient.recorder.totals(),
                    );
                    const measuredTurnShellWebSocket = transferDelta(
                      shellTurnStartTotals,
                      shellClient.recorder.totals(),
                    );
                    const measuredTurnSecondClientWebSocket = transferDelta(
                      secondTurnStartTotals,
                      secondClient.recorder.totals(),
                    );
                    const measuredTurnSqlStatements = sqlCounter.count() - turnStartSqlStatements;

                    // The second device drops and comes back with the cursors it
                    // held before the turn, one subscription at a time so the
                    // catch-up bytes stay separable.
                    yield* secondClient.close;
                    const reconnectSqlStart = sqlCounter.count();
                    const reconnected = yield* openMeasuredWsClient({ url: wsUrl, cookie });
                    const reconnectStartTotals = reconnected.recorder.totals();
                    const reconnectThreadItems = yield* subscribeThreadItems(
                      reconnected,
                      decodedThread.snapshotSequence,
                    );
                    const reconnectThreadMode = yield* awaitSubscriptionSynchronized(
                      reconnectThreadItems,
                      `${provider} reconnected thread subscription to synchronize`,
                    );
                    const reconnectThreadTotals = reconnected.recorder.totals();
                    const reconnectShellItems = yield* subscribeShellItems(
                      reconnected,
                      decodedShell.snapshotSequence,
                    );
                    const reconnectShellMode = yield* awaitSubscriptionSynchronized(
                      reconnectShellItems,
                      `${provider} reconnected shell subscription to synchronize`,
                    );
                    const reconnectShellTotals = reconnected.recorder.totals();
                    const reconnectSqlStatements = sqlCounter.count() - reconnectSqlStart;

                    const finalThreadSnapshot = yield* harness.snapshotQuery
                      .getThreadDetailSnapshot(TRANSFER_THREAD_ID)
                      .pipe(Effect.map(Option.getOrThrow));
                    const expectedAssistantText = expectedMeasuredAssistantText(provider);
                    const measuredAssistant = finalThreadSnapshot.thread.messages.find(
                      (message) =>
                        message.role === "assistant" && message.text === expectedAssistantText,
                    );
                    assert.isDefined(measuredAssistant);
                    assert.isTrue(
                      finalThreadSnapshot.thread.messages.length >= TRANSFER_HISTORY_TURN_COUNT * 2,
                    );
                    assert.equal(measuredAssistant?.streaming, false);
                    assert.equal(finalThreadSnapshot.thread.session?.status, "ready");
                    assert.equal(
                      finalThreadSnapshot.thread.checkpoints.length,
                      TRANSFER_HISTORY_TURN_COUNT + 1,
                    );

                    return {
                      provider,
                      threadSnapshot,
                      measuredTurnWebSocket,
                      shellSnapshot,
                      measuredTurnShellWebSocket,
                      measuredTurnSecondClientWebSocket,
                      reconnectThread: {
                        mode: reconnectThreadMode,
                        ...transferDelta(reconnectStartTotals, reconnectThreadTotals),
                      },
                      reconnectShell: {
                        mode: reconnectShellMode,
                        ...transferDelta(reconnectThreadTotals, reconnectShellTotals),
                      },
                      measuredTurnSqlStatements,
                      reconnectSqlStatements,
                    } satisfies TransferBudgetRun;
                  }),
                );
              }),
            (harness) => harness.dispose,
          ).pipe(
            Effect.provideService(Tracer.Tracer, sqlCounter.tracer),
            Effect.provide(NodeHttpServerTestWithWsDeflate),
          );
        },
        { concurrency: 1 },
      );

      const report = formatTransferBudgetReport(runs);
      yield* Effect.logInfo(`\n${report}`);
      const reportPath = yield* Config.string("T3CODE_TRANSFER_BUDGET_REPORT_PATH").pipe(
        Config.option,
      );
      if (Option.isSome(reportPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(reportPath.value, report);
      }
      const resultPath = yield* Config.string("T3CODE_TRANSFER_BUDGET_RESULT_PATH").pipe(
        Config.option,
      );
      if (Option.isSome(resultPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(resultPath.value, formatTransferBudgetResult(runs));
      }
      assert.deepEqual(transferBudgetViolations(runs), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
