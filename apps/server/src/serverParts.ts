import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Random from "effect/Random";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi, type RepositoryIdentity } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import { withUntracedRequests } from "./http.ts";
import * as ServerHttp from "./http.ts";
import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import * as Ws from "./ws.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as PullRequestHttp from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./telemetry/DelegatedTaskAnalytics.ts";
import * as ProviderUsageAnalytics from "./telemetry/ProviderUsageAnalytics.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/resetCreditCoordinator.ts";
import * as EventNdjsonLogger from "./provider/EventNdjsonLogger.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ProviderHostLive from "./provider/ProviderHostLive.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "./sourceControl/sourceControlDefinitions.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as SecretResolver from "./secrets/SecretResolver.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as PeerForwarding from "./peer/PeerForwarding.ts";
import * as RemoteDelegation from "./peer/RemoteDelegation.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerMcpClient from "./peer/PeerMcpClient.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as PreviewAgentActivity from "./preview/PreviewAgentActivity.ts";
import * as DesktopBrowserChannel from "./preview/DesktopBrowserChannel.ts";
import * as ServerBrowserStream from "./preview/ServerBrowserStream.ts";
import * as PreviewBrowser from "./preview/PreviewBrowser.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ManagedLimits from "./policy/managedLimits.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "./provider/ProviderUsageLimitsIngestion.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as Observability from "./observability/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as CodexManagedTokenBroker from "./provider/CodexManagedTokenBroker.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as RelayDeliveryProof from "./scheduledTasks/RelayDeliveryProof.ts";
import * as HeldHooksWaker from "./relay/HeldHooksWaker.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import {
  relayHookBaseUrl,
  ScheduledTaskWebhookOrigin,
} from "./scheduledTasks/ScheduledTaskService.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeRuntimeConfig,
  RELAY_URL_SECRET,
} from "./cloud/config.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentAuthPolicy from "./auth/EnvironmentAuthPolicy.ts";
import * as CloudHttp from "./cloud/http.ts";
import * as GuestHttp from "./guest/http.ts";
import * as CloudLink from "./cloud/CloudLink.ts";
import * as ConnectReachability from "./cloud/ConnectReachability.ts";
import { pendingServiceUpdateExists } from "./cloud/updateHandoff.ts";
import * as RelayTracing from "./cloud/relayTracing.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import {
  MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER,
  makeManagedTunnelRecovery,
  managedTunnelStartupAction,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
} from "./cloud/managedTunnelStartup.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudCliState from "./cloud/CliState.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ProcessGroupMetrics from "./resourceTelemetry/ProcessGroupMetrics.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as AntigravityUsage from "./provider/Drivers/AntigravityUsage.ts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as UsageService from "./usage/UsageService.ts";
import * as CodexUsageHistory from "./usage/CodexUsageHistory.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";
import * as IdleCompactionService from "./orchestration-v2/IdleCompactionService.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import { makePersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { acceptsPrivateNetworkConnection, loopbackUrlHostForAddress } from "./startupAccess.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as ProjectHttp from "./project/http.ts";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeRoutesTo,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as ServerActivation from "./serverActivation.ts";
import { HTTP_ROUTER_CONFIG, layerApplicationObservability, layerHttpServer, layerMakeRoutes, layerPlatformServices, layerRuntimeDependencies } from "./server.ts";

export const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before anything opens the database: one server per T3 home.
    const ownership = yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath);
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = Layer.succeed(ServerActivation.ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const cloudLinkParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const layerLauncher = ServiceLauncherClient.layer;

    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });

    const layerHttpListening = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const layerRuntimeState = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
        yield* awaitActivation;
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return;
        }

        const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
        const state = yield* makePersistedServerRuntimeState({
          config,
          port: address.port,
          serviceManaged: launcher.managed,
          managedPolicy: yield* ManagedPolicy.loadedPolicy(yield* ManagedPolicy.ManagedPolicy),
        });
        yield* ownership
          .publish(state)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
      }),
    );
    const layerTailscaleServe = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              const localHost = loopbackUrlHostForAddress(address);
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost,
              }).pipe(
                Effect.as({
                  localPort,
                  localHost: localHost.replace(/^\[|\]$/gu, ""),
                  servePort: config.tailscaleServePort,
                }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? Effect.all(
                    [
                      readTailscaleServeRoutesTo({
                        host: configured.localHost,
                        port: configured.localPort,
                      }),
                      readTailscaleStatus,
                    ],
                    { concurrency: 2 },
                  ).pipe(
                    // Another service may hold the root route by now, or it may sit under a
                    // former name, where `off` would act on the current one; only ours goes.
                    Effect.map(([routes, status]) =>
                      routes.some(
                        (route) =>
                          route.servePort === configured.servePort &&
                          route.mount === "/" &&
                          route.owner === undefined &&
                          route.ambiguous === undefined &&
                          route.host?.toLowerCase() === status.magicDnsName?.toLowerCase(),
                      ),
                    ),
                    Effect.orElseSucceed(() => false),
                    Effect.flatMap((ours) =>
                      ours
                        ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                            Effect.tap(() =>
                              Effect.logInfo("Tailscale Serve disabled", {
                                servePort: configured.servePort,
                              }),
                            ),
                          )
                        : Effect.logInfo(
                            "Tailscale Serve left on; its root route is not known to be ours",
                            {
                              servePort: configured.servePort,
                            },
                          ),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    const layerCloudDesiredLinkReconcile = Layer.effectDiscard(
      Effect.gen(function* () {
        const cloudLink = yield* CloudLink.CloudLink;
        // CloudLink unlinks on startup when the policy turns Connect off; nothing to restore.
        if (!ManagedLimits.allowsConnect(yield* ManagedPolicy.ManagedPolicy)) {
          yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
          return;
        }
        const releaseManagedTunnel = cloudLink.releaseManagedTunnelOnShutdown().pipe(
          Effect.timeout("10 seconds"),
          Effect.tap((released) =>
            released ? Effect.logInfo("Released the managed tunnel on shutdown") : Effect.void,
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Failed to release the managed tunnel on shutdown; the next link reuses it",
              { errors: Cause.prettyErrors(cause).map((error) => error.message) },
            ),
          ),
          Effect.asVoid,
        );
        // Trials own cleanup immediately after the old server exits, retaining tunnels for commit/rollback unless explicitly stopped.
        // Other runtimes wait for activation so failed standbys cannot tear down active tunnels.
        const cleanupBeforeActivation = yield* pendingServiceUpdateExists;
        if (cleanupBeforeActivation) {
          yield* Effect.addFinalizer(() => releaseManagedTunnel);
        }
        yield* ServerActivation.forkParked(
          Effect.gen(function* () {
            if (!cleanupBeforeActivation) {
              yield* Effect.addFinalizer(() => releaseManagedTunnel);
            }
            const server = yield* HttpServer.HttpServer;
            const address = server.address;
            if (typeof address === "string" || !("port" in address)) return;
            const localOrigin = `http://${loopbackUrlHostForAddress(address)}:${address.port}`;
            const endpointRuntime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
            const runManagedTunnelRecovery = yield* makeManagedTunnelRecovery({
              recover: (config: RelayManagedEndpointRuntimeConfig) =>
                cloudLink.recoverManagedTunnel(localOrigin, config, {
                  retryRuntimeFailures: true,
                }),
              isRetryable: (error) =>
                CloudLink.shouldRetryCloudLink(error) &&
                error._tag !== "CloudLinkEndpointUnavailableError",
            });
            const recoverManagedTunnel = (config: RelayManagedEndpointRuntimeConfig) =>
              runManagedTunnelRecovery(config).pipe(
                Effect.tap((recovered) =>
                  recovered ? Effect.logInfo("T3 Connect managed tunnel recovered") : Effect.void,
                ),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.interrupt
                    : Effect.logWarning("Failed to recover the T3 Connect managed tunnel", {
                        cause,
                      }),
                ),
              );
            yield* endpointRuntime.recoveryRequests.pipe(
              Stream.runForEach(recoverManagedTunnel),
              Effect.forkScoped,
            );
            const wantsCliLink = hasCloudPublicConfig
              ? yield* CloudCliState.readCliDesiredCloudLink.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link", { cause }).pipe(
                      Effect.as(false),
                    ),
                  ),
                )
              : false;
            // Recover reads so this fiber still registers and consumes recovery requests.
            const desiredCliLinkMode = wantsCliLink
              ? yield* CloudCliState.readCliDesiredLinkMode.pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to read the desired T3 Connect link mode", {
                      cause,
                    }).pipe(Effect.as("managed" as const)),
                  ),
                )
              : null;
            // Publish-only links must not expose the host through old managed configs.
            const startedConfirmed =
              desiredCliLinkMode === "publish_only"
                ? false
                : yield* cloudLink.startManagedTunnelIfOriginConfirmed(localOrigin).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to start the confirmed T3 Connect tunnel", {
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  );
            const startStoredManagedTunnel = cloudLink
              .startManagedTunnelIfOriginConfirmed(localOrigin, {
                requireConfirmedOrigin: false,
              })
              .pipe(
                Effect.tap((started) =>
                  started
                    ? Effect.logWarning(
                        "T3 Connect started the stored tunnel without relay confirmation",
                      )
                    : Effect.void,
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to start the stored T3 Connect tunnel", { cause }),
                ),
                Effect.asVoid,
              );
            const registerManagedTunnel = retryManagedTunnelRegistration(
              cloudLink.registerManagedTunnelRecovery(localOrigin, {
                retryRuntimeFailures: true,
              }),
              (error) =>
                CloudLink.shouldRetryCloudLink(error) &&
                error._tag !== "CloudLinkEndpointUnavailableError",
              startedConfirmed ? Effect.void : startStoredManagedTunnel,
            ).pipe(
              Effect.tap((result) =>
                result.status === "ready"
                  ? Effect.logInfo("T3 Connect managed tunnel recovery registered")
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to register T3 Connect managed tunnel recovery", {
                      cause,
                    }).pipe(Effect.as({ status: "unavailable" as const })),
              ),
            );
            // Jitter registrations so update waves do not hit the relay simultaneously.
            if (!startedConfirmed && desiredCliLinkMode !== "publish_only") {
              const jitter = yield* Random.nextIntBetween(
                0,
                Duration.toMillis(MANAGED_TUNNEL_FIRST_REGISTRATION_JITTER),
              );
              yield* Effect.sleep(Duration.millis(jitter));
            }
            const registration =
              desiredCliLinkMode === "publish_only"
                ? { status: "not_linked" as const }
                : yield* registerManagedTunnel;
            if (registration.status === "unavailable" && !startedConfirmed) {
              yield* startStoredManagedTunnel;
            }
            const startupAction = managedTunnelStartupAction({ wantsCliLink, registration });
            if (startupAction.action === "request_recovery") {
              yield* endpointRuntime.requestRecovery(startupAction.config);
            }
            if (startupAction.action === "reconcile_link") {
              const reconciledMode = yield* cloudLink
                .reconcileDesiredLinkIfStillDesired(localOrigin)
                .pipe(
                  (reconcile) =>
                    retryDesiredLinkReconcile(reconcile, CloudLink.shouldRetryCloudLink, (cause) =>
                      Effect.logWarning(
                        "T3 Connect relay is still unavailable; retrying the desired link in the background",
                        { cause },
                      ),
                    ),
                  Effect.tap((mode) =>
                    mode === null
                      ? Effect.void
                      : Effect.logInfo("T3 Connect desired link reconciled on startup"),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to reconcile T3 Connect desired link on startup", {
                      cause,
                    }).pipe(Effect.as(null)),
                  ),
                );
              if (reconciledMode === "managed") {
                const afterReconcile = yield* registerManagedTunnel;
                if (afterReconcile.status === "recovery_required") {
                  yield* endpointRuntime.requestRecovery(afterReconcile.config);
                }
              }
            }
          }),
        );
        yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);
      }),
    );

    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(cloudLinkParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(layerRuntimeDependencies), Layer.provide(layerLauncher));

    const layerRoutes = HttpRouter.serve(layerMakeRoutes.pipe(Layer.provide(layerLauncher)), {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      withUntracedRequests,
      Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)),
    );
    const layerServerApplication = Layer.mergeAll(
      layerRoutes,
      layerHttpListening,
      layerRuntimeState.pipe(Layer.provide(layerLauncher)),
      layerTailscaleServe,
      layerCloudDesiredLinkReconcile,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      Layer.provide(CloudLink.layer.pipe(Layer.provideMerge(ConnectReachability.layer))),
      Layer.provideMerge(layerRuntimeServices),
      Layer.provideMerge(
        McpSessionRegistry.layer.pipe(
          Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        ),
      ),
      Layer.provide(layerActivation),
      Layer.provideMerge(
        RelayTracing.layerServerRelayBroker.pipe(Layer.provide(ManagedPolicy.layer)),
      ),
      Layer.provideMerge(layerHttpServer),
      Layer.provide(layerApplicationObservability),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(layerPlatformServices),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer));

