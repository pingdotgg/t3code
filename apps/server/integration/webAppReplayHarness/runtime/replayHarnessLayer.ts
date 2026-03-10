import type { ServerProviderStatus } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { CodexAppServerManager } from "../../../src/codexAppServerManager.ts";
import { ServerConfig, type ServerConfigShape } from "../../../src/config.ts";
import { GitHubCli } from "../../../src/git/Services/GitHubCli.ts";
import { GitService } from "../../../src/git/Services/GitService.ts";
import { Open } from "../../../src/open.ts";
import { makeSqlitePersistenceLive } from "../../../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeCodexAdapterLive } from "../../../src/provider/Layers/CodexAdapter.ts";
import { ProviderAdapterRegistryLive } from "../../../src/provider/Layers/ProviderAdapterRegistry.ts";
import { makeProviderServiceLive } from "../../../src/provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderHealth } from "../../../src/provider/Services/ProviderHealth.ts";
import { makeServerRuntimeServicesLayer } from "../../../src/serverLayers.ts";
import { TerminalManager } from "../../../src/terminal/Services/Manager.ts";
import { AnalyticsService } from "../../../src/telemetry/Services/AnalyticsService.ts";

import { makeReplayCodexProcessController } from "../adapter/codexProcessController.ts";
import {
  defaultProviderStatuses,
  makeReplayGitHubCli,
  makeReplayGitService,
  noOpOpenService,
  noOpTerminalManager,
} from "../adapter/replayServices.ts";
import type { ReplayFixture } from "../types.ts";
import type { ReplayHarnessEnvironment } from "./replayHarnessEnvironment.ts";

export function createReplayDependenciesLayer(
  fixture: ReplayFixture,
  environment: ReplayHarnessEnvironment,
) {
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const codexProcessController = makeReplayCodexProcessController(fixture, environment.state);
  const codexAdapterLayer = makeCodexAdapterLive({
    makeManager: (services) =>
      new CodexAppServerManager(services, {
        processController: codexProcessController,
      }),
  });
  const providerRegistryLayer = ProviderAdapterRegistryLive.pipe(Layer.provide(codexAdapterLayer));
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(providerRegistryLayer),
    Layer.provide(providerSessionDirectoryLayer),
  );

  const replayGitServiceLayer = Layer.succeed(
    GitService,
    makeReplayGitService(fixture, environment.state),
  );
  const replayGitHubCliLayer = Layer.succeed(
    GitHubCli,
    makeReplayGitHubCli(fixture, environment.state),
  );
  const replayTerminalLayer = Layer.succeed(TerminalManager, noOpTerminalManager);
  const persistenceLayer = makeSqlitePersistenceLive(environment.dbPath);
  const infrastructureLayer = providerLayer.pipe(Layer.provideMerge(persistenceLayer));
  const serverConfigLayer = Layer.succeed(ServerConfig, {
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: environment.workspaceDir,
    keybindingsConfigPath: environment.keybindingsConfigPath,
    stateDir: environment.stateDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: true,
    logWebSocketEvents: false,
  } satisfies ServerConfigShape);
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.succeed(
      (fixture.providerStatuses as ReadonlyArray<ServerProviderStatus> | undefined) ??
        defaultProviderStatuses(),
    ),
  });
  const openLayer = Layer.succeed(Open, noOpOpenService);
  const runtimeLayer = Layer.merge(
    makeServerRuntimeServicesLayer({
      gitServiceLayer: replayGitServiceLayer,
      gitHubCliLayer: replayGitHubCliLayer,
      terminalLayer: replayTerminalLayer,
    }).pipe(Layer.provide(infrastructureLayer)),
    infrastructureLayer,
  );

  return Layer.empty.pipe(
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(openLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(AnalyticsService.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );
}
