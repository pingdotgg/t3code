import * as Http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, PlatformError, PubSub, Scope, Stream } from "effect";
import { describe, expect, it, afterEach, vi } from "vitest";
import { createServer } from "./wsServer";
import WebSocket from "ws";
import { ServerConfig, type ServerConfigShape } from "./config";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";

import {
  DEFAULT_TERMINAL_ID,
  EDITORS,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProviderItemId,
  ThreadId,
  TurnId,
  WS_CHANNELS,
  WS_METHODS,
  type WebSocketResponse,
  type ProviderRuntimeEvent,
  type ServerProviderStatus,
  type KeybindingsConfig,
  type ResolvedKeybindingsConfig,
  type WsPush,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule, DEFAULT_KEYBINDINGS } from "./keybindings";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth";
import { Open, type OpenShape } from "./open";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import type { GitCoreShape } from "./git/Services/GitCore.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitCommandError, GitManagerError } from "./git/Errors.ts";
import { MigrationError } from "@effect/sql-sqlite-bun/SqliteMigrator";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProviderItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
};

const defaultProviderStatuses: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

const defaultProviderHealthService: ProviderHealthShape = {
  getStatuses: Effect.succeed(defaultProviderStatuses),
};

class MockTerminalManager implements TerminalManagerShape {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  private key(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  emitEvent(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscriptionCount(): number {
    return this.listeners.size;
  }

  readonly open: TerminalManagerShape["open"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 4242,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly write: TerminalManagerShape["write"] = (input: TerminalWriteInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const existing = this.sessions.get(this.key(input.threadId, terminalId));
      if (!existing) {
        throw new Error(`Unknown terminal thread: ${input.threadId}`);
      }
      queueMicrotask(() => {
        this.emitEvent({
          type: "output",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
          data: input.data,
        });
      });
    });

  readonly resize: TerminalManagerShape["resize"] = (_input: TerminalResizeInput) => Effect.void;

  readonly clear: TerminalManagerShape["clear"] = (input: TerminalClearInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      queueMicrotask(() => {
        this.emitEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
        });
      });
    });

  readonly restart: TerminalManagerShape["restart"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 5252,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "restarted",
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly close: TerminalManagerShape["close"] = (input: TerminalCloseInput) =>
    Effect.sync(() => {
      if (input.terminalId) {
        this.sessions.delete(this.key(input.threadId, input.terminalId));
        return;
      }
      for (const key of this.sessions.keys()) {
        if (key.startsWith(`${input.threadId}\u0000`)) {
          this.sessions.delete(key);
        }
      }
    });

  readonly subscribe: TerminalManagerShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });

  readonly dispose: TerminalManagerShape["dispose"] = Effect.void;
}

function connectWs(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const pending: PendingMessages = { queue: [], waiters: [] };
    pendingBySocket.set(ws, pending);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const waiter = pending.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      pending.queue.push(parsed);
    });

    ws.once("open", () => resolve(ws));
    ws.once("error", () => reject(new Error("WebSocket connection failed")));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const pending = pendingBySocket.get(ws);
  if (!pending) {
    return Promise.reject(new Error("WebSocket not initialized"));
  }

  const queued = pending.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

function asWebSocketResponse(message: unknown): WebSocketResponse | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("id" in message)) return null;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== "string") return null;
  return message as WebSocketResponse;
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params?: unknown,
): Promise<WebSocketResponse> {
  const id = crypto.randomUUID();
  const body =
    method === ORCHESTRATION_WS_METHODS.dispatchCommand
      ? { _tag: method, command: params }
      : params && typeof params === "object" && !Array.isArray(params)
        ? { _tag: method, ...(params as Record<string, unknown>) }
        : { _tag: method };
  const message = JSON.stringify({ id, body });
  ws.send(message);

  // Wait for response with matching id
  while (true) {
    const parsed = asWebSocketResponse(await waitForMessage(ws));
    if (!parsed) {
      continue;
    }
    if (parsed.id === id) {
      return parsed;
    }
    if (parsed.id === "unknown") {
      return parsed;
    }
  }
}

async function waitForPush(
  ws: WebSocket,
  channel: string,
  predicate?: (push: WsPush) => boolean,
  maxMessages = 120,
): Promise<WsPush> {
  const take = async (remaining: number): Promise<WsPush> => {
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for push on ${channel}`);
    }
    const message = (await waitForMessage(ws)) as WsPush;
    if (message.type !== "push" || message.channel !== channel) {
      return take(remaining - 1);
    }
    if (!predicate || predicate(message)) {
      return message;
    }
    return take(remaining - 1);
  };
  return take(maxMessages);
}

async function requestPath(
  port: number,
  requestPath: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = Http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function compileKeybindings(bindings: KeybindingsConfig): ResolvedKeybindingsConfig {
  const resolved: Array<ResolvedKeybindingsConfig[number]> = [];
  for (const binding of bindings) {
    const compiled = compileResolvedKeybindingRule(binding);
    if (!compiled) {
      throw new Error(`Unexpected invalid keybinding in test setup: ${binding.command}`);
    }
    resolved.push(compiled);
  }
  return resolved;
}

const DEFAULT_RESOLVED_KEYBINDINGS = compileKeybindings([...DEFAULT_KEYBINDINGS]);
const VALID_EDITOR_IDS = new Set(EDITORS.map((editor) => editor.id));

function expectAvailableEditors(value: unknown): void {
  expect(Array.isArray(value)).toBe(true);
  for (const editorId of value as unknown[]) {
    expect(typeof editorId).toBe("string");
    expect(VALID_EDITOR_IDS.has(editorId as (typeof EDITORS)[number]["id"])).toBe(true);
  }
}

describe("WebSocket Server", () => {
  let server: Http.Server | null = null;
  let serverScope: Scope.Closeable | null = null;
  const connections: WebSocket[] = [];
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTestServer(
    options: {
      persistenceLayer?: Layer.Layer<
        SqlClient.SqlClient,
        SqlError.SqlError | MigrationError | PlatformError.PlatformError
      >;
      cwd?: string;
      autoBootstrapProjectFromCwd?: boolean;
      logWebSocketEvents?: boolean;
      devUrl?: string;
      authToken?: string;
      stateDir?: string;
      staticDir?: string;
      providerLayer?: Layer.Layer<ProviderService, never>;
      providerHealth?: ProviderHealthShape;
      open?: OpenShape;
      gitManager?: GitManagerShape;
      gitCore?: Pick<GitCoreShape, "listBranches" | "initRepo" | "pullCurrentBranch">;
      terminalManager?: TerminalManagerShape;
    } = {},
  ): Promise<Http.Server> {
    if (serverScope) {
      throw new Error("Test server is already running");
    }

    const stateDir = options.stateDir ?? makeTempDir("t3code-ws-state-");
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const persistenceLayer = options.persistenceLayer ?? SqlitePersistenceMemory;
    const providerLayer = options.providerLayer ?? makeServerProviderLayer();
    const providerHealthLayer = Layer.succeed(
      ProviderHealth,
      options.providerHealth ?? defaultProviderHealthService,
    );
    const openLayer = Layer.succeed(Open, options.open ?? defaultOpenService);
    const serverConfigLayer = Layer.succeed(ServerConfig, {
      mode: "web",
      port: 0,
      host: undefined,
      cwd: options.cwd ?? "/test/project",
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      stateDir,
      staticDir: options.staticDir,
      devUrl: options.devUrl ? new URL(options.devUrl) : undefined,
      noBrowser: true,
      authToken: options.authToken,
      autoBootstrapProjectFromCwd: options.autoBootstrapProjectFromCwd ?? false,
      logWebSocketEvents: options.logWebSocketEvents ?? Boolean(options.devUrl),
    } satisfies ServerConfigShape);
    const infrastructureLayer = providerLayer.pipe(Layer.provideMerge(persistenceLayer));
    const runtimeOverrides = Layer.mergeAll(
      options.gitManager ? Layer.succeed(GitManager, options.gitManager) : Layer.empty,
      options.gitCore
        ? Layer.succeed(GitCore, options.gitCore as unknown as GitCoreShape)
        : Layer.empty,
      options.terminalManager
        ? Layer.succeed(TerminalManager, options.terminalManager)
        : Layer.empty,
    );

    const runtimeLayer = Layer.merge(
      Layer.merge(
        makeServerRuntimeServicesLayer().pipe(Layer.provide(infrastructureLayer)),
        infrastructureLayer,
      ),
      runtimeOverrides,
    );
    const dependenciesLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(providerHealthLayer),
      Layer.provideMerge(openLayer),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtimeServices = await Effect.runPromise(
      Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
    );

    try {
      const runtime = await Effect.runPromise(
        createServer().pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
      );
      serverScope = scope;
      return runtime;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  async function closeTestServer() {
    if (!serverScope) return;
    const scope = serverScope;
    serverScope = null;
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  afterEach(async () => {
    for (const ws of connections) {
      ws.close();
    }
    connections.length = 0;
    await closeTestServer();
    server = null;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("sends welcome message on connect", async () => {
    server = await createTestServer({ cwd: "/test/project" });
    // Get the actual port after listen
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);

    const message = (await waitForMessage(ws)) as WsPush;
    expect(message.type).toBe("push");
    expect(message.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(message.data).toEqual({
      cwd: "/test/project",
      projectName: "project",
    });
  });

  it("serves persisted attachments from stateDir", async () => {
    const stateDir = makeTempDir("t3code-state-attachments-");
    const attachmentPath = path.join(stateDir, "attachments", "thread-a", "message-a", "0.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-attachment"));

    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/attachments/thread-a/message-a/0.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-attachment"));
  });

  it("serves persisted attachments for URL-encoded paths", async () => {
    const stateDir = makeTempDir("t3code-state-attachments-encoded-");
    const attachmentPath = path.join(
      stateDir,
      "attachments",
      "thread%20folder",
      "message%20folder",
      "file%20name.png",
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from("hello-encoded-attachment"));

    server = await createTestServer({ cwd: "/test/project", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(
      `http://127.0.0.1:${port}/attachments/thread%20folder/message%20folder/file%20name.png`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes).toEqual(Buffer.from("hello-encoded-attachment"));
  });

  it("serves static index for root path", async () => {
    const stateDir = makeTempDir("t3code-state-static-root-");
    const staticDir = makeTempDir("t3code-static-root-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>static-root</h1>", "utf8");

    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("static-root");
  });

  it("rejects static path traversal attempts", async () => {
    const stateDir = makeTempDir("t3code-state-static-traversal-");
    const staticDir = makeTempDir("t3code-static-traversal-");
    fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>safe</h1>", "utf8");

    server = await createTestServer({ cwd: "/test/project", stateDir, staticDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await requestPath(port, "/..%2f..%2fetc/passwd");
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("Invalid static file path");
  });

  it("bootstraps the cwd project on startup when enabled", async () => {
    server = await createTestServer({
      cwd: "/test/bootstrap-workspace",
      autoBootstrapProjectFromCwd: true,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    const welcome = (await waitForMessage(ws)) as WsPush; // welcome
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(welcome.data).toEqual(
      expect.objectContaining({
        cwd: "/test/bootstrap-workspace",
        projectName: "bootstrap-workspace",
        bootstrapProjectId: expect.any(String),
        bootstrapThreadId: expect.any(String),
      }),
    );

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshotResponse.error).toBeUndefined();
    const snapshot = snapshotResponse.result as {
      projects: Array<{
        id: string;
        workspaceRoot: string;
        title: string;
        defaultModel: string | null;
      }>;
      threads: Array<{
        id: string;
        projectId: string;
        title: string;
        model: string;
        branch: string | null;
        worktreePath: string | null;
      }>;
    };
    const bootstrapProjectId = (welcome.data as { bootstrapProjectId?: string }).bootstrapProjectId;
    const bootstrapThreadId = (welcome.data as { bootstrapThreadId?: string }).bootstrapThreadId;
    expect(bootstrapProjectId).toBeDefined();
    expect(bootstrapThreadId).toBeDefined();

    expect(snapshot.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapProjectId,
          workspaceRoot: "/test/bootstrap-workspace",
          title: "bootstrap-workspace",
          defaultModel: "gpt-5-codex",
        }),
      ]),
    );
    expect(snapshot.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bootstrapThreadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: "gpt-5-codex",
          branch: null,
          worktreePath: null,
        }),
      ]),
    );
  });

  it("includes bootstrap ids in welcome when cwd project and thread already exist", async () => {
    const stateDir = makeTempDir("t3code-state-bootstrap-existing-");
    const persistenceLayer = makeSqlitePersistenceLive(path.join(stateDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
    const cwd = "/test/bootstrap-existing";

    server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
    });
    let addr = server.address();
    let port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const firstWs = await connectWs(port);
    connections.push(firstWs);
    const firstWelcome = (await waitForMessage(firstWs)) as WsPush;
    const firstBootstrapProjectId = (firstWelcome.data as { bootstrapProjectId?: string })
      .bootstrapProjectId;
    const firstBootstrapThreadId = (firstWelcome.data as { bootstrapThreadId?: string })
      .bootstrapThreadId;
    expect(firstBootstrapProjectId).toBeDefined();
    expect(firstBootstrapThreadId).toBeDefined();

    firstWs.close();
    await closeTestServer();
    server = null;

    server = await createTestServer({
      cwd,
      stateDir,
      persistenceLayer,
      autoBootstrapProjectFromCwd: true,
    });
    addr = server.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const secondWs = await connectWs(port);
    connections.push(secondWs);
    const secondWelcome = (await waitForMessage(secondWs)) as WsPush;
    expect(secondWelcome.channel).toBe(WS_CHANNELS.serverWelcome);
    expect(secondWelcome.data).toEqual(
      expect.objectContaining({
        cwd,
        projectName: "bootstrap-existing",
        bootstrapProjectId: firstBootstrapProjectId,
        bootstrapThreadId: firstBootstrapThreadId,
      }),
    );
  });

  it("logs outbound websocket push events in dev mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
      // Keep test output clean while verifying websocket logs.
    });

    server = await createTestServer({
      cwd: "/test/project",
      devUrl: "http://localhost:5173",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    expect(
      logSpy.mock.calls.some(([message]) => {
        if (typeof message !== "string") return false;
        return (
          message.includes("[ws]") &&
          message.includes("outgoing push") &&
          message.includes(`channel="${WS_CHANNELS.serverWelcome}"`)
        );
      }),
    ).toBe(true);
  });

  it("responds to server.getConfig", async () => {
    const stateDir = makeTempDir("t3code-state-get-config-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome message
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [],
      providers: defaultProviderStatuses,
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("bootstraps default keybindings file when missing", async () => {
    const stateDir = makeTempDir("t3code-state-bootstrap-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    expect(fs.existsSync(keybindingsPath)).toBe(false);

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [],
      providers: defaultProviderStatuses,
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);

    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(persistedConfig).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("falls back to defaults and reports malformed keybindings config issues", async () => {
    const stateDir = makeTempDir("t3code-state-malformed-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "{ not-json", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      issues: [
        {
          kind: "keybindings.malformed-config",
          message: expect.stringContaining("expected JSON array"),
        },
      ],
      providers: defaultProviderStatuses,
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
    expect(fs.readFileSync(keybindingsPath, "utf8")).toBe("{ not-json");
  });

  it("ignores invalid keybinding entries but keeps valid entries and reports issues", async () => {
    const stateDir = makeTempDir("t3code-state-partial-invalid-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+d+o", command: "terminal.new" },
        { key: "mod+x", command: "not-a-real-command" },
      ]),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const result = response.result as {
      cwd: string;
      keybindingsConfigPath: string;
      keybindings: ResolvedKeybindingsConfig;
      issues: Array<{ kind: string; index?: number; message: string }>;
      providers: ReadonlyArray<ServerProviderStatus>;
      availableEditors: unknown;
    };
    expect(result.cwd).toBe("/my/workspace");
    expect(result.keybindingsConfigPath).toBe(keybindingsPath);
    expect(result.issues).toEqual([
      {
        kind: "keybindings.invalid-entry",
        index: 1,
        message: expect.any(String),
      },
      {
        kind: "keybindings.invalid-entry",
        index: 2,
        message: expect.any(String),
      },
    ]);
    expect(result.keybindings).toHaveLength(DEFAULT_RESOLVED_KEYBINDINGS.length);
    expect(result.keybindings.some((entry) => entry.command === "terminal.toggle")).toBe(true);
    expect(result.keybindings.some((entry) => entry.command === "terminal.new")).toBe(true);
    expect(result.providers).toEqual(defaultProviderStatuses);
    expectAvailableEditors(result.availableEditors);
  });

  it("pushes server.configUpdated issues when keybindings file changes", async () => {
    const stateDir = makeTempDir("t3code-state-keybindings-watch-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(keybindingsPath, "[]", "utf8");

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    fs.writeFileSync(keybindingsPath, "{ not-json", "utf8");
    const malformedPush = await waitForPush(
      ws,
      WS_CHANNELS.serverConfigUpdated,
      (push) =>
        Array.isArray((push.data as { issues?: unknown[] }).issues) &&
        Boolean((push.data as { issues: Array<{ kind: string }> }).issues[0]) &&
        (push.data as { issues: Array<{ kind: string }> }).issues[0]!.kind ===
          "keybindings.malformed-config",
    );
    expect(malformedPush.data).toEqual({
      issues: [{ kind: "keybindings.malformed-config", message: expect.any(String) }],
      providers: defaultProviderStatuses,
    });

    fs.writeFileSync(keybindingsPath, "[]", "utf8");
    const successPush = await waitForPush(
      ws,
      WS_CHANNELS.serverConfigUpdated,
      (push) =>
        Array.isArray((push.data as { issues?: unknown[] }).issues) &&
        (push.data as { issues: unknown[] }).issues.length === 0,
    );
    expect(successPush.data).toEqual({ issues: [], providers: defaultProviderStatuses });
  });

  it("routes shell.openInEditor through the injected open service", async () => {
    const openCalls: Array<{ cwd: string; editor: string }> = [];
    const openService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: (input) => {
        openCalls.push({ cwd: input.cwd, editor: input.editor });
        return Effect.void;
      },
    };

    server = await createTestServer({ cwd: "/my/workspace", open: openService });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.shellOpenInEditor, {
      cwd: "/my/workspace",
      editor: "cursor",
    });
    expect(response.error).toBeUndefined();
    expect(openCalls).toEqual([{ cwd: "/my/workspace", editor: "cursor" }]);
  });

  it("reads keybindings from the configured state directory", async () => {
    const stateDir = makeTempDir("t3code-state-keybindings-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([
        { key: "cmd+j", command: "terminal.toggle" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
      ]),
      "utf8",
    );
    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileKeybindings(persistedConfig),
      issues: [],
      providers: defaultProviderStatuses,
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors((response.result as { availableEditors: unknown }).availableEditors);
  });

  it("upserts keybinding rules and updates cached server config", async () => {
    const stateDir = makeTempDir("t3code-state-upsert-keybinding-");
    const keybindingsPath = path.join(stateDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );

    server = await createTestServer({ cwd: "/my/workspace", stateDir });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const upsertResponse = await sendRequest(ws, WS_METHODS.serverUpsertKeybinding, {
      key: "mod+shift+r",
      command: "script.run-tests.run",
    });
    expect(upsertResponse.error).toBeUndefined();
    const persistedConfig = JSON.parse(
      fs.readFileSync(keybindingsPath, "utf8"),
    ) as KeybindingsConfig;
    const persistedCommands = new Set(persistedConfig.map((entry) => entry.command));
    for (const defaultRule of DEFAULT_KEYBINDINGS) {
      expect(persistedCommands.has(defaultRule.command)).toBe(true);
    }
    expect(persistedCommands.has("script.run-tests.run")).toBe(true);
    expect(upsertResponse.result).toEqual({
      keybindings: compileKeybindings(persistedConfig),
      issues: [],
    });

    const configResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(configResponse.error).toBeUndefined();
    expect(configResponse.result).toEqual({
      cwd: "/my/workspace",
      keybindingsConfigPath: keybindingsPath,
      keybindings: compileKeybindings(persistedConfig),
      issues: [],
      providers: defaultProviderStatuses,
      availableEditors: expect.any(Array),
    });
    expectAvailableEditors(
      (configResponse.result as { availableEditors: unknown }).availableEditors,
    );
  });

  it("returns error for unknown methods", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome push
    await waitForMessage(ws);

    const response = await sendRequest(ws, "nonexistent.method");
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain("Invalid request format");
  });

  it("returns error when requesting turn diff for unknown thread", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-missing",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns error when requesting turn diff with an inverted range", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-any",
      fromTurnCount: 2,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      "fromTurnCount must be less than or equal to toTurnCount",
    );
  });

  it("returns error when requesting full thread diff for unknown thread", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
      threadId: "thread-missing",
      toTurnCount: 2,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Thread 'thread-missing' not found.");
  });

  it("returns retryable error when requested turn exceeds current checkpoint turn count", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-diff-project-create",
      projectId: "project-diff",
      title: "Diff Project",
      workspaceRoot: "/tmp/ws-diff-project",
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-diff-thread-create",
      threadId: "thread-diff",
      projectId: "project-diff",
      title: "Diff Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const response = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getTurnDiff, {
      threadId: "thread-diff",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("exceeds current turn count");
  });

  it("keeps orchestration domain push behavior for provider runtime events", async () => {
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      startSession: (threadId) =>
        Effect.succeed({
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: ({ threadId }) =>
        Effect.succeed({
          threadId,
          turnId: asTurnId("provider-turn-1"),
        }),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      rollbackConversation: () => unsupported(),
      stopAll: () => Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const providerLayer = Layer.succeed(ProviderService, providerService);

    server = await createTestServer({
      cwd: "/test",
      providerLayer,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const createdAt = new Date().toISOString();
    const createProjectResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "project.create",
      commandId: "cmd-ws-project-create",
      projectId: "project-1",
      title: "WS Project",
      workspaceRoot: "/tmp/ws-project",
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    expect(createProjectResponse.error).toBeUndefined();
    const createThreadResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.create",
      commandId: "cmd-ws-runtime-thread-create",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread 1",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    expect(createThreadResponse.error).toBeUndefined();

    const startTurnResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.dispatchCommand, {
      type: "thread.turn.start",
      commandId: "cmd-ws-runtime-turn-start",
      threadId: "thread-1",
      message: {
        messageId: "msg-ws-runtime-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      assistantDeliveryMode: "streaming",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt,
    });
    expect(startTurnResponse.error).toBeUndefined();

    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string };
      return event.type === "thread.session-set";
    });

    emitRuntimeEvent(
      {
        type: "content.delta",
        eventId: asEventId("evt-ws-runtime-message-delta"),
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        turnId: asTurnId("turn-1"),
        itemId: asProviderItemId("item-1"),
        payload: {
          streamKind: "assistant_text",
          delta: "hello from runtime",
        },
      } as unknown as ProviderRuntimeEvent,
    );

    const domainPush = await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string; payload?: { messageId?: string; text?: string } };
      return (
        event.type === "thread.message-sent" && event.payload?.messageId === "assistant:item-1"
      );
    });

    const domainEvent = domainPush.data as {
      type: string;
      payload: { messageId: string; text: string };
    };
    expect(domainEvent.type).toBe("thread.message-sent");
    expect(domainEvent.payload.messageId).toBe("assistant:item-1");
    expect(domainEvent.payload.text).toBe("hello from runtime");
  });

  it("routes terminal RPC methods and broadcasts terminal events", async () => {
    const cwd = makeTempDir("t3code-ws-terminal-cwd-");
    const terminalManager = new MockTerminalManager();
    server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const open = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "thread-1",
      cwd,
      cols: 100,
      rows: 24,
    });
    expect(open.error).toBeUndefined();
    expect((open.result as TerminalSessionSnapshot).threadId).toBe("thread-1");
    expect((open.result as TerminalSessionSnapshot).terminalId).toBe(DEFAULT_TERMINAL_ID);

    const write = await sendRequest(ws, WS_METHODS.terminalWrite, {
      threadId: "thread-1",
      data: "echo hello\n",
    });
    expect(write.error).toBeUndefined();

    const resize = await sendRequest(ws, WS_METHODS.terminalResize, {
      threadId: "thread-1",
      cols: 120,
      rows: 30,
    });
    expect(resize.error).toBeUndefined();

    const clear = await sendRequest(ws, WS_METHODS.terminalClear, {
      threadId: "thread-1",
    });
    expect(clear.error).toBeUndefined();

    const restart = await sendRequest(ws, WS_METHODS.terminalRestart, {
      threadId: "thread-1",
      cwd,
      cols: 120,
      rows: 30,
    });
    expect(restart.error).toBeUndefined();

    const close = await sendRequest(ws, WS_METHODS.terminalClose, {
      threadId: "thread-1",
      deleteHistory: true,
    });
    expect(close.error).toBeUndefined();

    const manualEvent: TerminalEvent = {
      type: "output",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      createdAt: new Date().toISOString(),
      data: "manual test output\n",
    };
    terminalManager.emitEvent(manualEvent);

    const push = (await waitForMessage(ws)) as WsPush;
    expect(push.type).toBe("push");
    expect(push.channel).toBe(WS_CHANNELS.terminalEvent);
    expect((push.data as TerminalEvent).type).toBe("output");
  });

  it("detaches terminal event listener on stop for injected manager", async () => {
    const terminalManager = new MockTerminalManager();
    server = await createTestServer({
      cwd: "/test",
      terminalManager,
    });

    expect(terminalManager.subscriptionCount()).toBe(1);

    await closeTestServer();
    server = null;

    expect(terminalManager.subscriptionCount()).toBe(0);
  });

  it("returns validation errors for invalid terminal open params", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.terminalOpen, {
      threadId: "",
      cwd: "",
      cols: 1,
      rows: 1,
    });
    expect(response.error).toBeDefined();
  });

  it("handles invalid JSON gracefully", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    // Consume welcome
    await waitForMessage(ws);

    // Send garbage
    ws.send("not json at all");

    let response: WebSocketResponse | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const message = asWebSocketResponse(await waitForMessage(ws));
      if (!message) {
        continue;
      }
      if (message.id === "unknown") {
        response = message;
        break;
      }
      if (message.error) {
        response = message;
        break;
      }
    }
    expect(response).toBeDefined();
    expect(response!.error).toBeDefined();
    expect(response!.error!.message).toContain("Invalid request format");
  });

  it("catches websocket message handler rejections and keeps the socket usable", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const brokenOpenService: OpenShape = {
      openBrowser: () => Effect.void,
      openInEditor: () =>
        Effect.sync(() => BigInt(1)).pipe(Effect.map((result) => result as unknown as void)),
    };

    try {
      server = await createTestServer({ cwd: "/test", open: brokenOpenService });
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      const ws = await connectWs(port);
      connections.push(ws);
      await waitForMessage(ws);

      ws.send(
        JSON.stringify({
          id: "req-broken-open",
          body: {
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/tmp",
            editor: "cursor",
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandledRejections).toHaveLength(0);

      const workspace = makeTempDir("t3code-ws-handler-still-usable-");
      fs.writeFileSync(path.join(workspace, "file.txt"), "ok\n", "utf8");
      const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
        cwd: workspace,
        query: "file",
        limit: 5,
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              path: "file.txt",
              kind: "file",
            }),
          ]),
        }),
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("returns errors for removed projects CRUD methods", async () => {
    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.projectsList);
    expect(listResponse.result).toBeUndefined();
    expect(listResponse.error?.message).toContain("Invalid request format");

    const addResponse = await sendRequest(ws, WS_METHODS.projectsAdd, {
      cwd: "/tmp/project-a",
    });
    expect(addResponse.result).toBeUndefined();
    expect(addResponse.error?.message).toContain("Invalid request format");

    const removeResponse = await sendRequest(ws, WS_METHODS.projectsRemove, {
      id: "project-a",
    });
    expect(removeResponse.result).toBeUndefined();
    expect(removeResponse.error?.message).toContain("Invalid request format");
  });

  it("supports projects.searchEntries", async () => {
    const workspace = makeTempDir("t3code-ws-workspace-entries-");
    fs.mkdirSync(path.join(workspace, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "components", "Composer.tsx"),
      "export {};",
      "utf8",
    );
    fs.writeFileSync(path.join(workspace, "README.md"), "# test", "utf8");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsSearchEntries, {
      cwd: workspace,
      query: "comp",
      limit: 10,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "src/components", kind: "directory" }),
        expect.objectContaining({ path: "src/components/Composer.tsx", kind: "file" }),
      ]),
      truncated: false,
    });
  });

  it("supports projects.writeFile within the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "plans/effect-rpc.md",
      contents: "# Plan\n\n- step 1\n",
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      relativePath: "plans/effect-rpc.md",
    });
    expect(fs.readFileSync(path.join(workspace, "plans", "effect-rpc.md"), "utf8")).toBe(
      "# Plan\n\n- step 1\n",
    );
  });

  it("rejects projects.writeFile paths outside the workspace root", async () => {
    const workspace = makeTempDir("t3code-ws-write-file-reject-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.projectsWriteFile, {
      cwd: workspace,
      relativePath: "../escape.md",
      contents: "# no\n",
    });

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("Workspace file path must stay within the project root.");
    expect(fs.existsSync(path.join(workspace, "..", "escape.md"))).toBe(false);
  });

  it("routes git core methods over websocket", async () => {
    const listBranches = vi.fn(() =>
      Effect.succeed({
        branches: [],
        isRepo: false,
      }),
    );
    const initRepo = vi.fn(() => Effect.void);
    const pullCurrentBranch = vi.fn(() =>
      Effect.fail(
        new GitCommandError({
          operation: "GitCore.test.pullCurrentBranch",
          detail: "No upstream configured",
          command: "git pull",
          cwd: "/repo/path",
        }),
      ),
    );

    server = await createTestServer({
      cwd: "/test",
      gitCore: {
        listBranches,
        initRepo,
        pullCurrentBranch,
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const listResponse = await sendRequest(ws, WS_METHODS.gitListBranches, { cwd: "/repo/path" });
    expect(listResponse.error).toBeUndefined();
    expect(listResponse.result).toEqual({ branches: [], isRepo: false });
    expect(listBranches).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const initResponse = await sendRequest(ws, WS_METHODS.gitInit, { cwd: "/repo/path" });
    expect(initResponse.error).toBeUndefined();
    expect(initRepo).toHaveBeenCalledWith({ cwd: "/repo/path" });

    const pullResponse = await sendRequest(ws, WS_METHODS.gitPull, { cwd: "/repo/path" });
    expect(pullResponse.result).toBeUndefined();
    expect(pullResponse.error?.message).toContain("No upstream configured");
    expect(pullCurrentBranch).toHaveBeenCalledWith("/repo/path");
  });

  it("supports git.status over websocket", async () => {
    const statusResult = {
      branch: "feature/test",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/index.ts", insertions: 7, deletions: 2 }],
        insertions: 7,
        deletions: 2,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const status = vi.fn(() => Effect.succeed(statusResult));
    const runStackedAction = vi.fn(() => Effect.void as any);
    const gitManager: GitManagerShape = { status, runStackedAction };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitStatus, {
      cwd: "/test",
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(statusResult);
    expect(status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("returns errors from git.runStackedAction", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.fail(
        new GitManagerError({
          operation: "GitManager.test.runStackedAction",
          detail: "Cannot push from detached HEAD.",
        }),
      ),
    );
    const gitManager: GitManagerShape = {
      status: vi.fn(() => Effect.void as any),
      runStackedAction,
    };

    server = await createTestServer({ cwd: "/test", gitManager });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.gitRunStackedAction, {
      cwd: "/test",
      action: "commit_push",
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain("detached HEAD");
    expect(runStackedAction).toHaveBeenCalledWith({
      cwd: "/test",
      action: "commit_push",
    });
  });

  it("rejects websocket connections without a valid auth token", async () => {
    server = await createTestServer({ cwd: "/test", authToken: "secret-token" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    await expect(connectWs(port)).rejects.toThrow("WebSocket connection failed");

    const authorizedWs = await connectWs(port, "secret-token");
    connections.push(authorizedWs);
    const welcome = (await waitForMessage(authorizedWs)) as WsPush;
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);
  });
});
