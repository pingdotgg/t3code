import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProviderStatus, TerminalOpenInput, TerminalSessionSnapshot } from "@t3tools/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";

import {
  CodexAppServerManager,
  type CodexAppServerChildProcess,
  type CodexAppServerProcessController,
  type CodexCliVersionCheckResult,
} from "../src/codexAppServerManager.ts";
import { ServerConfig, type ServerConfigShape } from "../src/config.ts";
import { GitCommandError, GitHubCliError } from "../src/git/Errors.ts";
import { GitHubCli, type GitHubCliShape } from "../src/git/Services/GitHubCli.ts";
import {
  GitService,
  type ExecuteGitInput,
  type ExecuteGitResult,
  type GitServiceShape,
} from "../src/git/Services/GitService.ts";
import { Open, type OpenShape } from "../src/open.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeCodexAdapterLive } from "../src/provider/Layers/CodexAdapter.ts";
import { ProviderAdapterRegistryLive } from "../src/provider/Layers/ProviderAdapterRegistry.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderHealth, type ProviderHealthShape } from "../src/provider/Services/ProviderHealth.ts";
import { type ProcessRunResult } from "../src/processRunner.ts";
import { makeServerRuntimeServicesLayer } from "../src/serverLayers.ts";
import { TerminalManager, type TerminalManagerShape } from "../src/terminal/Services/Manager.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { createServer } from "../src/wsServer.ts";

import webViteConfig from "../../web/vite.config.ts";

interface ReplayRef {
  readonly $ref: string;
}

interface ReplayInteraction {
  readonly name: string;
  readonly service: string;
  readonly match?: Record<string, unknown>;
  readonly whenState?: Record<string, unknown>;
  readonly capture?: Record<string, string>;
  readonly setState?: Record<string, unknown>;
  readonly result?: unknown;
  readonly notifications?: ReadonlyArray<unknown>;
  readonly error?: {
    readonly message: string;
  };
}

export interface ReplayFixture {
  readonly version: 1;
  readonly state?: Record<string, unknown>;
  readonly providerStatuses?: ReadonlyArray<ServerProviderStatus>;
  readonly interactions: ReadonlyArray<ReplayInteraction>;
}

interface ReplayScopes {
  readonly request: unknown;
  readonly state: Record<string, unknown>;
}

interface ResolvedInteraction<T> {
  readonly interaction: ReplayInteraction;
  readonly result: T;
  readonly notifications: ReadonlyArray<unknown>;
}

interface ReplayCodexClientRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

function webRootPath(): string {
  return path.resolve(fileURLToPath(new URL("../../web", import.meta.url)));
}

function fixturePathForTestFile(testFileUrl: string): string {
  const testFilePath = fileURLToPath(testFileUrl);
  const extension = path.extname(testFilePath);
  if (!extension) {
    throw new Error(`Cannot derive replay fixture path from '${testFilePath}'.`);
  }
  return `${testFilePath.slice(0, -extension.length)}.fixture.ts`;
}

async function readReplayFixture(testFileUrl: string): Promise<ReplayFixture> {
  const fixturePath = fixturePathForTestFile(testFileUrl);
  const module = (await import(pathToFileURL(fixturePath).href)) as {
    readonly default?: ReplayFixture;
  };
  if (!module.default) {
    throw new Error(`Replay fixture '${fixturePath}' must export a default value.`);
  }
  return module.default;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isReplayRef(value: unknown): value is ReplayRef {
  return isPlainRecord(value) && typeof value.$ref === "string";
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry)) as T;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return Buffer.from(value) as T;
  }
  if (ArrayBuffer.isView(value)) {
    if ("slice" in value && typeof value.slice === "function") {
      return value.slice() as T;
    }
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    ) as T;
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0) as T;
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const clonedEntries = Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]);
  return Object.fromEntries(clonedEntries) as T;
}

function readPath(source: unknown, pathExpression: string): unknown {
  const segments = pathExpression.split(".");
  let current: unknown = source;

  for (const segment of segments) {
    if (!segment) continue;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isPlainRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function readScopedPath(pathExpression: string, scopes: ReplayScopes): unknown {
  if (pathExpression.startsWith("state.")) {
    return readPath(scopes.state, pathExpression.slice("state.".length));
  }
  if (pathExpression.startsWith("request.")) {
    return readPath(scopes.request, pathExpression.slice("request.".length));
  }
  throw new Error(`Unsupported replay path '${pathExpression}'.`);
}

function resolveTemplate(value: unknown, scopes: ReplayScopes): unknown {
  if (isReplayRef(value)) {
    return readScopedPath(value.$ref, scopes);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplate(entry, scopes));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const resolvedEntries = Object.entries(value).map(([key, entry]) => [
    key,
    resolveTemplate(entry, scopes),
  ]);
  return Object.fromEntries(resolvedEntries);
}

function matchesPartial(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((entry, index) => matchesPartial(actual[index], entry));
  }

  if (isPlainRecord(expected)) {
    if (!isPlainRecord(actual)) {
      return false;
    }
    return Object.entries(expected).every(([key, value]) => matchesPartial(actual[key], value));
  }

  return Object.is(actual, expected);
}

function findMatchingInteraction(
  interactions: ReadonlyArray<ReplayInteraction>,
  service: string,
  request: unknown,
  state: Record<string, unknown>,
): ReplayInteraction | null {
  for (const interaction of interactions) {
    if (interaction.service !== service) {
      continue;
    }
    const scopes = { request, state };
    const match = resolveTemplate(interaction.match ?? {}, scopes);
    if (!matchesPartial(request, match)) {
      continue;
    }
    const whenState = resolveTemplate(interaction.whenState ?? {}, scopes);
    if (!matchesPartial(state, whenState)) {
      continue;
    }
    return interaction;
  }
  return null;
}

function applyInteractionState(interaction: ReplayInteraction, scopes: ReplayScopes): void {
  for (const [key, pathExpression] of Object.entries(interaction.capture ?? {})) {
    scopes.state[key] = readScopedPath(pathExpression, scopes);
  }
  for (const [key, value] of Object.entries(interaction.setState ?? {})) {
    scopes.state[key] = resolveTemplate(value, scopes);
  }
}

function resolveInteraction<T>(
  fixture: ReplayFixture,
  service: string,
  request: unknown,
  state: Record<string, unknown>,
): ResolvedInteraction<T> {
  const interaction = findMatchingInteraction(fixture.interactions, service, request, state);
  if (!interaction) {
    throw new Error(`No replay interaction matched ${service}: ${JSON.stringify(request)}.`);
  }

  const scopes = { request, state };
  applyInteractionState(interaction, scopes);
  if (interaction.error) {
    throw new Error(interaction.error.message);
  }

  return {
    interaction,
    result: resolveTemplate(interaction.result, scopes) as T,
    notifications: resolveTemplate(interaction.notifications ?? [], scopes) as ReadonlyArray<unknown>,
  };
}

function defaultProviderStatuses(): ReadonlyArray<ServerProviderStatus> {
  return [
    {
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-03-10T12:00:00.000Z",
    },
  ];
}

function noOpTerminalSnapshot(input: TerminalOpenInput): TerminalSessionSnapshot {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId ?? "default",
    cwd: input.cwd,
    status: "running",
    pid: null,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date().toISOString(),
  };
}

const noOpTerminalManager: TerminalManagerShape = {
  open: (input) => Effect.succeed(noOpTerminalSnapshot(input)),
  write: () => Effect.void,
  resize: () => Effect.void,
  clear: () => Effect.void,
  restart: (input) => Effect.succeed(noOpTerminalSnapshot(input)),
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => undefined),
  dispose: Effect.void,
};

const noOpOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
};

function replayGitCommandFailure(input: ExecuteGitInput, cause: unknown): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: `git ${input.args.join(" ")}`,
    cwd: input.cwd,
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

function replayGitHubCliFailure(operation: string, cause: unknown): GitHubCliError {
  return new GitHubCliError({
    operation: operation as "execute" | "stdout",
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function makeReplayGitService(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): GitServiceShape {
  return {
    execute: (input) =>
      Effect.try({
        try: () => resolveInteraction<ExecuteGitResult>(fixture, "git.execute", input, state).result,
        catch: (cause) => replayGitCommandFailure(input, cause),
      }),
  };
}

function unexpectedGitHubCliCall(operation: string, input: unknown): GitHubCliError {
  return replayGitHubCliFailure(
    operation,
    new Error(`Unexpected GitHub CLI call: ${operation} (${JSON.stringify(input)}).`),
  );
}

function makeReplayGitHubCli(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): GitHubCliShape {
  return {
    execute: (input) =>
      Effect.try({
        try: () => resolveInteraction<ProcessRunResult>(fixture, "github.execute", input, state).result,
        catch: (cause) => replayGitHubCliFailure("execute", cause),
      }),
    listOpenPullRequests: (input) =>
      Effect.fail(unexpectedGitHubCliCall("listOpenPullRequests", input)),
    getPullRequest: (input) => Effect.fail(unexpectedGitHubCliCall("getPullRequest", input)),
    getRepositoryCloneUrls: (input) =>
      Effect.fail(unexpectedGitHubCliCall("getRepositoryCloneUrls", input)),
    createPullRequest: (input) => Effect.fail(unexpectedGitHubCliCall("createPullRequest", input)),
    getDefaultBranch: (input) => Effect.fail(unexpectedGitHubCliCall("getDefaultBranch", input)),
    checkoutPullRequest: (input) =>
      Effect.fail(unexpectedGitHubCliCall("checkoutPullRequest", input)),
  };
}

class ReplayCodexChildProcess
  extends EventEmitter<{ error: [error: Error]; exit: [code: number | null, signal: NodeJS.Signals | null] }>
  implements CodexAppServerChildProcess
{
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable & { writable: boolean };
  readonly pid = undefined;

  killed = false;
  private inputBuffer = "";

  constructor(
    private readonly onRequest: (
      request: ReplayCodexClientRequest,
      child: ReplayCodexChildProcess,
    ) => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.handleStdinChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
          callback();
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(`Failed to process codex stdin: ${String(error)}`);
          this.emit("error", normalized);
          callback(normalized);
        }
      },
    }) as Writable & { writable: boolean };
  }

  kill(): boolean {
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("exit", null, "SIGTERM");
    });
    return true;
  }

  writeJsonLine(message: unknown): void {
    if (this.killed) {
      return;
    }
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdinChunk(chunk: string): void {
    this.inputBuffer += chunk;

    while (true) {
      const newlineIndex = this.inputBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = this.inputBuffer.slice(0, newlineIndex).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      const message = JSON.parse(line) as unknown;
      if (!isPlainRecord(message) || typeof message.method !== "string") {
        continue;
      }
      if (!("id" in message) || (typeof message.id !== "string" && typeof message.id !== "number")) {
        continue;
      }

      this.onRequest(
        {
          id: message.id,
          method: message.method,
          ...(message.params !== undefined ? { params: message.params } : {}),
        },
        this,
      );
    }
  }
}

function toReplayError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function makeReplayCodexProcessController(
  fixture: ReplayFixture,
  state: Record<string, unknown>,
): CodexAppServerProcessController {
  return {
    spawnAppServer: (input) =>
      new ReplayCodexChildProcess((request, child) => {
        let resolved: ResolvedInteraction<unknown>;
        try {
          resolved = resolveInteraction<unknown>(
            fixture,
            "codex.request",
            {
              binaryPath: input.binaryPath,
              cwd: input.cwd,
              method: request.method,
              ...(request.params !== undefined ? { params: request.params } : {}),
            },
            state,
          );
        } catch (error) {
          queueMicrotask(() => {
            child.writeJsonLine({
              id: request.id,
              error: {
                message: toReplayError(error).message,
              },
            });
          });
          return;
        }

        queueMicrotask(() => {
          child.writeJsonLine({
            id: request.id,
            result: resolved.result,
          });
          for (const notification of resolved.notifications) {
            child.writeJsonLine(notification);
          }
        });
      }),
    runVersionCheck: (input) => {
      try {
        return resolveInteraction<CodexCliVersionCheckResult>(
          fixture,
          "codex.versionCheck",
          input,
          state,
        ).result;
      } catch (error) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: toReplayError(error),
        };
      }
    },
    kill: (child) => {
      child.kill();
    },
  };
}

export interface WebAppReplayHarness {
  readonly appUrl: string;
  readonly openPage: (
    browser: Browser,
    options?: BrowserContextOptions,
  ) => Promise<{ context: BrowserContext; page: Page }>;
  readonly dispose: () => Promise<void>;
}

export async function createWebAppReplayHarness(testFileUrl: string): Promise<WebAppReplayHarness> {
  const fixture = await readReplayFixture(testFileUrl);
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
  } satisfies ProviderHealthShape);
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
    const wsUrl = `ws://127.0.0.1:${address.port}`;

    process.chdir(webRootPath());
    webServer = await createViteServer({
      configFile: false,
      ...webViteConfig,
      root: webRootPath(),
      clearScreen: false,
      define: {
        ...webViteConfig.define,
        "import.meta.env.VITE_WS_URL": JSON.stringify(wsUrl),
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
      openPage: async (browser, options) => {
        const context = await browser.newContext(options);
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
