import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";

import { CodexAppServerManager } from "../../src/codexAppServerManager.ts";
import { ServerConfig, type ServerConfigShape } from "../../src/config.ts";
import { GitHubCli } from "../../src/git/Services/GitHubCli.ts";
import { GitService } from "../../src/git/Services/GitService.ts";
import { Open } from "../../src/open.ts";
import { makeSqlitePersistenceLive } from "../../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeCodexAdapterLive } from "../../src/provider/Layers/CodexAdapter.ts";
import { ProviderAdapterRegistryLive } from "../../src/provider/Layers/ProviderAdapterRegistry.ts";
import { makeProviderServiceLive } from "../../src/provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderHealth } from "../../src/provider/Services/ProviderHealth.ts";
import { makeServerRuntimeServicesLayer } from "../../src/serverLayers.ts";
import { TerminalManager } from "../../src/terminal/Services/Manager.ts";
import { AnalyticsService } from "../../src/telemetry/Services/AnalyticsService.ts";
import { createServer } from "../../src/wsServer.ts";

import webViteConfig from "../../../web/vite.config.ts";

import { makeReplayCodexProcessController } from "./codexProcess.ts";
import { readReplayFixture } from "./fixtureLoader.ts";
import { cloneJson } from "./template.ts";
import {
  defaultProviderStatuses,
  makeReplayGitHubCli,
  makeReplayGitService,
  noOpOpenService,
  noOpTerminalManager,
} from "./services.ts";
import type { ReplayFixture } from "./types.ts";

export interface WebAppReplayHarness {
  readonly appUrl: string;
  readonly openPage: (
    browser: Browser,
    options?: BrowserContextOptions,
  ) => Promise<{ context: BrowserContext; page: Page }>;
  readonly dispose: () => Promise<void>;
}

interface CreateWebAppReplayHarnessOptions {
  readonly fixture?: ReplayFixture;
  readonly fixtureName?: string;
}

function webRootPath(): string {
  return path.resolve(fileURLToPath(new URL("../../../web", import.meta.url)));
}

export async function createWebAppReplayHarness(
  testFileUrl: string,
  options?: CreateWebAppReplayHarnessOptions,
): Promise<WebAppReplayHarness> {
  const fixture = options?.fixture ?? (await readReplayFixture(testFileUrl, options?.fixtureName));
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-web-replay-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const stateDir = path.join(rootDir, "state");
  const dbPath = path.join(stateDir, "state.sqlite");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const state = cloneJson(fixture.state ?? {});
  state.cwd = workspaceDir;
  state.projectName = state.projectName ?? (path.basename(workspaceDir) || "workspace");

  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const codexProcessController = makeReplayCodexProcessController(fixture, state);
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

  const replayGitServiceLayer = Layer.succeed(GitService, makeReplayGitService(fixture, state));
  const replayGitHubCliLayer = Layer.succeed(GitHubCli, makeReplayGitHubCli(fixture, state));
  const replayTerminalLayer = Layer.succeed(TerminalManager, noOpTerminalManager);
  const persistenceLayer = makeSqlitePersistenceLive(dbPath);
  const infrastructureLayer = providerLayer.pipe(Layer.provideMerge(persistenceLayer));
  const serverConfigLayer = Layer.succeed(ServerConfig, {
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: workspaceDir,
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    stateDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: true,
    logWebSocketEvents: false,
  } satisfies ServerConfigShape);
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.succeed(fixture.providerStatuses ?? defaultProviderStatuses()),
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
  const dependenciesLayer = Layer.empty.pipe(
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(openLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(AnalyticsService.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );

  let scope: Scope.Closeable | null = null;
  let webServer: ViteDevServer | null = null;
  const previousCwd = process.cwd();

  try {
    scope = await Effect.runPromise(Scope.make("sequential"));
    const runtimeServices = await Effect.runPromise(
      Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
    );
    const httpServer = await Effect.runPromise(
      createServer().pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
    );
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Replay HTTP server did not expose a TCP address.");
    }

    process.chdir(webRootPath());
    webServer = await createViteServer({
      configFile: false,
      ...webViteConfig,
      root: webRootPath(),
      clearScreen: false,
      define: {
        ...webViteConfig.define,
        "import.meta.env.VITE_WS_URL": JSON.stringify(`ws://127.0.0.1:${address.port}`),
      },
      server: {
        ...webViteConfig.server,
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        hmr: {
          protocol: "ws",
          host: "127.0.0.1",
        },
      },
    });
    await webServer.listen();

    const appUrl = webServer.resolvedUrls?.local[0];
    if (!appUrl) {
      throw new Error("Vite dev server did not expose a local URL.");
    }

    return {
      appUrl,
      openPage: async (browser, browserContextOptions) => {
        const context = await browser.newContext(browserContextOptions);
        const page = await context.newPage();
        return { context, page };
      },
      dispose: async () => {
        await webServer?.close().catch(() => undefined);
        if (scope) {
          await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
        }
        process.chdir(previousCwd);
        fs.rmSync(rootDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await webServer?.close().catch(() => undefined);
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
    }
    process.chdir(previousCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}
