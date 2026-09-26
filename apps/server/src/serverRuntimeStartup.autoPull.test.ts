import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it.effect("parks automatic pull until activation without delaying command readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const prepared = yield* Deferred.make<void>();
      const commitTrial = yield* Deferred.make<void>();
      const statusCalled = yield* Deferred.make<string>();
      const cwd = "/auto-pull-project";
      const updatedAt = "2026-01-01T00:00:00.000Z";
      const snapshot = {
        snapshotSequence: 0,
        projects: [
          {
            id: ProjectId.make("auto-pull-project"),
            title: "Auto pull project",
            workspaceRoot: cwd,
            defaultModelSelection: null,
            scripts: [],
            createdAt: updatedAt,
            updatedAt,
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt,
      };
      const dependencies: Layer.Layer<
        Exclude<Effect.Services<ReturnType<typeof ServerRuntimeStartup.make>>, Scope.Scope>
      > = Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)({
          ...(yield* ServerConfig.deriveServerPaths(cwd, undefined).pipe(
            Effect.provide(Path.layer),
          )),
          baseDir: cwd,
          logLevel: "Error",
          traceMinLevel: "Info",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 1024,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpLogsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "test",
          otlpHeaders: undefined,
          otlpProtocol: "http/json",
          staticDir: undefined,
          devAllowedOrigins: [],
          desktopBootstrapToken: undefined,
          logWebSocketEvents: false,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          mode: "desktop",
          cwd,
          host: "localhost",
          port: 3773,
          devUrl: undefined,
          noBrowser: true,
          startupPresentation: "browser",
          autoBootstrapProjectFromCwd: false,
        }),
        Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
        Layer.mock(OrchestrationReactor.OrchestrationReactor)({ start: () => Effect.void }),
        Layer.mock(ProviderSessionReaper.ProviderSessionReaper)({ start: () => Effect.void }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...event, sequence: 1 }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("auto-pull-environment"),
            label: "Test environment",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () => Effect.succeed(snapshot),
          getCommandReadModel: () => Effect.succeed(snapshot),
          listActivitiesByKind: () => Effect.succeed([]),
          getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 0 }),
        }),
        Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
          listBindings: () => Effect.succeed([]),
        }),
        Layer.mock(ProviderService.ProviderService)({ listSessions: () => Effect.succeed([]) }),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
          managed: true,
          prepareTrial: Deferred.succeed(prepared, undefined).pipe(
            Effect.andThen(Deferred.await(commitTrial)),
            Effect.as(undefined),
          ),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          statusDetails: (root) =>
            Deferred.succeed(statusCalled, root).pipe(Effect.andThen(Effect.never)),
        }),
        Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void }),
        Layer.mock(OrchestrationEngine.OrchestrationEngineService)({}),
        NodeCrypto.layer,
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
        Path.layer,
      );

      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;

        // A reverted, awaited pull reaches statusDetails instead of prepareTrial.
        // Race the two receipts so that regression fails without a timeout.
        yield* Effect.raceFirst(Deferred.await(prepared), Deferred.await(statusCalled));
        expect(yield* Deferred.isDone(activation)).toBe(false);
        expect(yield* Deferred.isDone(statusCalled)).toBe(false);
        expect(yield* Deferred.isDone(prepared)).toBe(true);

        yield* Deferred.succeed(commitTrial, undefined);
        yield* Deferred.await(activation);
        expect(yield* Deferred.await(statusCalled)).toBe(cwd);
        // statusDetails can never finish; readiness must not depend on it.
        yield* startup.awaitCommandReady;
      }).pipe(
        Effect.provide(
          ServerRuntimeStartup.layerWithOptions({
            activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
            awaitAuxiliaryParked: Effect.void,
          }).pipe(Layer.provide(dependencies)),
        ),
        Effect.provideService(ServerActivation, Deferred.await(activation)),
      );
    }),
  ),
);
