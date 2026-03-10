import { Effect, Exit, Layer, Scope } from "effect";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { ViteDevServer } from "vite";

import { createServer } from "../../src/wsServer.ts";

import { readReplayFixture } from "@t3tools/rr-e2e";

import { createReplayHarnessEnvironment } from "./runtime/replayHarnessEnvironment.ts";
import { createReplayDependenciesLayer } from "./runtime/replayHarnessLayer.ts";
import { startReplayViteServer } from "./runtime/replayViteServer.ts";
import type { ReplayFixture } from "./types.ts";

export interface WebAppReplayHarness {
  readonly appUrl: string;
  readonly dispose: () => Promise<void>;
  readonly openPage: (
    browser: Browser,
    options?: BrowserContextOptions,
  ) => Promise<{ context: BrowserContext; page: Page }>;
}

interface CreateWebAppReplayHarnessOptions {
  readonly fixture?: ReplayFixture;
  readonly fixtureName?: string;
}

const noop = (): void => undefined;

async function disposeReplayHarness(options: {
  readonly environment: ReturnType<typeof createReplayHarnessEnvironment>;
  readonly restoreWorkingDirectory: () => void;
  readonly scope: Scope.Closeable | null;
  readonly webServer: ViteDevServer | null;
}): Promise<void> {
  await options.webServer?.close().catch(() => undefined);
  if (options.scope) {
    await Effect.runPromise(Scope.close(options.scope, Exit.void)).catch(() => undefined);
  }
  options.restoreWorkingDirectory();
  options.environment.cleanup();
}

export async function createWebAppReplayHarness(
  testFileUrl: string,
  options?: CreateWebAppReplayHarnessOptions,
): Promise<WebAppReplayHarness> {
  const fixture =
    options?.fixture ??
    ((await readReplayFixture(testFileUrl, options?.fixtureName)) as ReplayFixture);
  const environment = createReplayHarnessEnvironment(fixture);
  const dependenciesLayer = createReplayDependenciesLayer(fixture, environment);

  let restoreWorkingDirectory: () => void = noop;
  let scope: Scope.Closeable | null = null;
  let webServer: ViteDevServer | null = null;

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

    const replayViteServer = await startReplayViteServer(address.port);
    restoreWorkingDirectory = replayViteServer.restoreWorkingDirectory;
    webServer = replayViteServer.webServer;

    return {
      appUrl: replayViteServer.appUrl,
      openPage: async (browser, browserContextOptions) => {
        const context = await browser.newContext(browserContextOptions);
        const page = await context.newPage();
        return { context, page };
      },
      dispose: async () =>
        disposeReplayHarness({
          environment,
          restoreWorkingDirectory,
          scope,
          webServer,
        }),
    };
  } catch (error) {
    await disposeReplayHarness({
      environment,
      restoreWorkingDirectory,
      scope,
      webServer,
    });
    throw error;
  }
}
