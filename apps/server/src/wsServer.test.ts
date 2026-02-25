import * as Http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect";
import { describe, expect, it, afterEach, vi } from "vitest";
import { createServer } from "./wsServer";
import WebSocket from "ws";
import { ServerConfig, type ServerConfigShape } from "./config";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";

import {
  DEFAULT_TERMINAL_ID,
  EventId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProviderItemId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  WS_CHANNELS,
  WS_METHODS,
  type WebSocketResponse,
  type ProviderRuntimeEvent,
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
import type { TerminalManagerShape } from "./terminalManager";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { SqlClient } from "effect/unstable/sql";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { Open, type OpenShape } from "./open";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProviderSessionId = (value: string): ProviderSessionId =>
  ProviderSessionId.makeUnsafe(value);
const asProviderThreadId = (value: string): ProviderThreadId => ProviderThreadId.makeUnsafe(value);
const asProviderTurnId = (value: string): ProviderTurnId => ProviderTurnId.makeUnsafe(value);
const asProviderItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
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
      for (const key of [...this.sessions.keys()]) {
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

  readonly dispose: TerminalManagerShape["dispose"] = () => Effect.void;
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

function mergeWithDefaultsForTest(custom: KeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return DEFAULT_RESOLVED_KEYBINDINGS;
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  return compileKeybindings([...retainedDefaults, ...custom].slice(-256));
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
      persistenceLayer?: Layer.Layer<SqlClient.SqlClient, any>;
      cwd?: string;
      autoBootstrapProjectFromCwd?: boolean;
      devUrl?: string;
      authToken?: string;
      stateDir?: string;
      providerLayer?: Layer.Layer<ProviderService, unknown>;
      open?: OpenShape;
      gitManager?: {
        status: (input: { cwd: string }) => Promise<unknown>;
        runStackedAction: (input: { cwd: string; action: string }) => Promise<unknown>;
      };
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
    const openLayer = Layer.succeed(Open, options.open ?? defaultOpenService);
    const serverConfigLayer = Layer.succeed(ServerConfig, {
      mode: "web",
      port: 0,
      host: undefined,
      cwd: options.cwd ?? "/test/project",
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      stateDir,
      staticDir: undefined,
      devUrl: options.devUrl ? new URL(options.devUrl) : undefined,
      noBrowser: true,
      authToken: options.authToken,
    } satisfies ServerConfigShape);
    const infrastructureLayer = providerLayer.pipe(Layer.provideMerge(persistenceLayer));
    const runtimeLayer = Layer.merge(
      makeServerRuntimeServicesLayer().pipe(Layer.provide(infrastructureLayer)),
      infrastructureLayer,
    );
    const dependenciesLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(openLayer),
      Layer.provideMerge(serverConfigLayer),
    );
    const runtimeServices = await Effect.runPromise(
      Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
    );

    try {
      const runtime = await Effect.runPromise(
        createServer({
          autoBootstrapProjectFromCwd: options.autoBootstrapProjectFromCwd ?? false,
          ...(options.gitManager ? { gitManager: options.gitManager as never } : {}),
          ...(options.terminalManager ? { terminalManager: options.terminalManager } : {}),
        }).pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
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
    await waitForMessage(ws); // welcome

    const snapshotResponse = await sendRequest(ws, ORCHESTRATION_WS_METHODS.getSnapshot);
    expect(snapshotResponse.error).toBeUndefined();
    const snapshot = snapshotResponse.result as {
      projects: Array<{ workspaceRoot: string; title: string; defaultModel: string | null }>;
    };

    expect(snapshot.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceRoot: "/test/bootstrap-workspace",
          title: "bootstrap-workspace",
          defaultModel: "gpt-5-codex",
        }),
      ]),
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
    const fakeHome = makeTempDir("t3code-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    server = await createTestServer({ cwd: "/my/workspace" });
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
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
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

  it("reads keybindings from ~/.t3/keybindings.json", async () => {
    const fakeHome = makeTempDir("t3code-home-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify([
        { key: "cmd+j", command: "terminal.toggle" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
      ]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindings: mergeWithDefaultsForTest([
        { key: "cmd+j", command: "terminal.toggle" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
      ]),
    });
  });

  it("warns and ignores invalid keybinding entries", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-invalid-entry-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+z", command: "invalid.command", when: "terminalFocus" },
      ]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindings: mergeWithDefaultsForTest([{ key: "mod+j", command: "terminal.toggle" }]),
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("ignoring invalid keybinding entries"),
      ),
    ).toBe(true);
  });

  it("warns and ignores keybindings with malformed when expressions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-invalid-when-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle", when: "terminalFocus && (" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("ignoring invalid keybinding entries"),
      ),
    ).toBe(true);
  });

  it("reads keybindings once at startup and caches the resolved config", async () => {
    const fakeHome = makeTempDir("t3code-home-cached-config-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const keybindingsPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "cmd+j", command: "terminal.toggle" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const firstResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(firstResponse.error).toBeUndefined();
    expect(firstResponse.result).toEqual({
      cwd: "/my/workspace",
      keybindings: mergeWithDefaultsForTest([{ key: "cmd+j", command: "terminal.toggle" }]),
    });

    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "cmd+k", command: "terminal.toggle" }]),
      "utf8",
    );

    const secondResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(secondResponse.error).toBeUndefined();
    expect(secondResponse.result).toEqual(firstResponse.result);
  });

  it("upserts keybinding rules and updates cached server config", async () => {
    const fakeHome = makeTempDir("t3code-home-upsert-keybinding-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    const keybindingsPath = path.join(configDir, "keybindings.json");
    fs.writeFileSync(
      keybindingsPath,
      JSON.stringify([{ key: "mod+j", command: "terminal.toggle" }]),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
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
    expect(upsertResponse.result).toEqual({
      keybindings: mergeWithDefaultsForTest([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]),
    });

    const persistedConfig = JSON.parse(fs.readFileSync(keybindingsPath, "utf8")) as Array<{
      key: string;
      command: string;
    }>;
    expect(persistedConfig).toEqual([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+shift+r", command: "script.run-tests.run" },
    ]);

    const configResponse = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(configResponse.error).toBeUndefined();
    expect(configResponse.result).toEqual({
      cwd: "/my/workspace",
      keybindings: mergeWithDefaultsForTest([
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]),
    });
  });

  it("warns and ignores unsupported keybindings config format", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-unsupported-format-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "keybindings.json"),
      JSON.stringify({ "terminal.toggle": "mod+j" }),
      "utf8",
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("unsupported format; expected array"),
      ),
    ).toBe(true);
  });

  it("warns and ignores malformed keybindings config files", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeHome = makeTempDir("t3code-home-invalid-");
    const configDir = path.join(fakeHome, ".t3");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "keybindings.json"), "{not-json", "utf8");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    server = await createTestServer({ cwd: "/my/workspace" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);

    await waitForMessage(ws);

    const response = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      cwd: "/my/workspace",
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    });
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("ignoring malformed keybindings config"),
      ),
    ).toBe(true);
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
    const sessionId = asProviderSessionId("sess-test");
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const providerService: ProviderServiceShape = {
      startSession: () =>
        Effect.succeed({
          sessionId,
          provider: "codex",
          status: "ready",
          threadId: asProviderThreadId("provider-thread-1"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      sendTurn: () =>
        Effect.succeed({
          threadId: asProviderThreadId("provider-thread-1"),
          turnId: asProviderTurnId("provider-turn-1"),
        }),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([]),
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
      createdAt,
    });
    expect(startTurnResponse.error).toBeUndefined();

    await waitForPush(ws, ORCHESTRATION_WS_CHANNELS.domainEvent, (push) => {
      const event = push.data as { type?: string };
      return event.type === "thread.session-set";
    });

    emitRuntimeEvent({
      type: "message.delta",
      eventId: asEventId("evt-ws-runtime-message-delta"),
      provider: "codex",
      sessionId,
      createdAt: new Date().toISOString(),
      turnId: asProviderTurnId("turn-1"),
      itemId: asProviderItemId("item-1"),
      delta: "hello from runtime",
    });

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

  it("supports git methods over websocket", async () => {
    const repoCwd = makeTempDir("t3code-ws-git-project-");

    server = await createTestServer({ cwd: "/test" });
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const ws = await connectWs(port);
    connections.push(ws);
    await waitForMessage(ws);

    const beforeInit = await sendRequest(ws, WS_METHODS.gitListBranches, { cwd: repoCwd });
    expect(beforeInit.error).toBeUndefined();
    expect(beforeInit.result).toEqual({ branches: [], isRepo: false });

    const initResponse = await sendRequest(ws, WS_METHODS.gitInit, { cwd: repoCwd });
    expect(initResponse.error).toBeUndefined();

    const afterInit = await sendRequest(ws, WS_METHODS.gitListBranches, {
      cwd: repoCwd,
    });
    expect(afterInit.error).toBeUndefined();
    expect((afterInit.result as { isRepo: boolean }).isRepo).toBe(true);

    const pullResponse = await sendRequest(ws, WS_METHODS.gitPull, { cwd: repoCwd });
    expect(pullResponse.result).toBeUndefined();
    expect(pullResponse.error?.message).toBeDefined();
    expect(pullResponse.error?.message).not.toContain("Unknown method");
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
      openPr: null,
    };

    const gitManager = {
      status: vi.fn().mockResolvedValue(statusResult),
      runStackedAction: vi.fn(),
    };

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
    expect(gitManager.status).toHaveBeenCalledWith({ cwd: "/test" });
  });

  it("returns errors from git.runStackedAction", async () => {
    const gitManager = {
      status: vi.fn(),
      runStackedAction: vi.fn().mockRejectedValue(new Error("Cannot push from detached HEAD.")),
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
    expect(gitManager.runStackedAction).toHaveBeenCalledWith({
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
