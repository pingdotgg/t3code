import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_TERMINAL_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderRuntimeEvent,
  ServerRpcGroup,
  type ServerConfig as ServerConfigPayload,
  type ServerProviderStatus,
  type ServerUpsertKeybindingResult,
  type TerminalEvent,
  type TerminalOpenInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import { describe, expect } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { HttpClient, HttpServer } from "effect/unstable/http";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { afterEach, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import { Open, type OpenShape } from "./open";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { ServerRuntimeStateLive } from "./serverRuntime";
import { makeServerAppLayer } from "./server";
import { makeServerRuntimeServicesLayer } from "./serverLayers";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";

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

const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
};

const defaultProviderService: ProviderServiceShape = {
  startSession: () => Effect.die(new Error("startSession not implemented in test")),
  sendTurn: () => Effect.die(new Error("sendTurn not implemented in test")),
  interruptTurn: () => Effect.die(new Error("interruptTurn not implemented in test")),
  respondToRequest: () => Effect.die(new Error("respondToRequest not implemented in test")),
  respondToUserInput: () => Effect.die(new Error("respondToUserInput not implemented in test")),
  stopSession: () => Effect.die(new Error("stopSession not implemented in test")),
  listSessions: () => Effect.succeed([]),
  getCapabilities: () => Effect.die(new Error("getCapabilities not implemented in test")),
  rollbackConversation: () => Effect.die(new Error("rollbackConversation not implemented in test")),
  streamEvents: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
};

class MockTerminalManager implements TerminalManagerShape {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  private key(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
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
        this.emit({
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
      if (!this.sessions.has(this.key(input.threadId, terminalId))) {
        throw new Error(`Unknown terminal ${input.threadId}/${terminalId}`);
      }
      queueMicrotask(() => {
        this.emit({
          type: "output",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
          data: input.data,
        });
      });
    });

  readonly resize: TerminalManagerShape["resize"] = () => Effect.void;
  readonly clear: TerminalManagerShape["clear"] = () => Effect.void;
  readonly restart: TerminalManagerShape["restart"] = (input) => this.open(input);
  readonly close: TerminalManagerShape["close"] = () => Effect.void;

  readonly subscribe: TerminalManagerShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });

  readonly dispose: TerminalManagerShape["dispose"] = Effect.void;
}

const makeRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeServerRpcClient = RpcClient.make(ServerRpcGroup);
type ServerRpcClient = Effect.Success<typeof makeServerRpcClient>;

const withRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: ServerRpcClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, never, never> =>
  Effect.scoped(
    makeServerRpcClient.pipe(
      Effect.flatMap(f),
      Effect.provide(makeRpcProtocolLayer(wsUrl)),
    ),
  ).pipe(Effect.orDie) as Effect.Effect<A, never, never>;

const getServerConfigEffect = (client: ServerRpcClient) => {
  const typedClient = client as ServerRpcClient & {
    readonly getServerConfig: (_: undefined) => Effect.Effect<ServerConfigPayload, never, never>;
  };
  return typedClient.getServerConfig(undefined);
};

const getSnapshotEffect = (client: ServerRpcClient) => {
  const typedClient = client as ServerRpcClient & {
    readonly getSnapshot: (_: undefined) => Effect.Effect<OrchestrationReadModel, never, never>;
  };
  return typedClient.getSnapshot(undefined);
};

const upsertKeybindingEffect = (client: ServerRpcClient) => {
  const typedClient = client as ServerRpcClient & {
    readonly upsertKeybinding: (
      input: {
        readonly key: "mod+shift+y";
        readonly command: "chat.new";
      },
    ) => Effect.Effect<ServerUpsertKeybindingResult, never, never>;
  };
  return typedClient.upsertKeybinding({
      key: "mod+shift+y",
      command: "chat.new",
    });
};

interface TestServerContext {
  readonly client: HttpClient.HttpClient;
  readonly wsUrl: string;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const makeTestServicesLayer = (options: {
  readonly providerHealth: ProviderHealthShape;
  readonly providerService: ProviderServiceShape;
  readonly open: OpenShape;
  readonly terminalManager?: TerminalManagerShape;
}) => {
  const providerLayer = Layer.succeed(ProviderService, options.providerService);
  const providerHealthLayer = Layer.succeed(ProviderHealth, options.providerHealth);
  const openLayer = Layer.succeed(Open, options.open);
  const runtimeOverrides = options.terminalManager
    ? Layer.succeed(TerminalManager, options.terminalManager)
    : Layer.empty;
  const nodeServicesLayer = NodeServices.layer;
  const providerBackedRuntimeLayer = makeServerRuntimeServicesLayer().pipe(
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(nodeServicesLayer),
  );
  const baseServicesLayer = Layer.mergeAll(
    nodeServicesLayer,
    providerBackedRuntimeLayer,
    providerLayer,
    providerHealthLayer,
    SqlitePersistenceMemory,
    openLayer,
    runtimeOverrides,
  );

  return Layer.mergeAll(
    baseServicesLayer,
    ServerRuntimeStateLive.pipe(Layer.provide(baseServicesLayer)),
  );
};

function withTestServer<A, E, R>(
  options: {
    readonly cwd?: string;
    readonly autoBootstrapProjectFromCwd?: boolean;
    readonly authToken?: string;
    readonly stateDir?: string;
    readonly staticDir?: string;
    readonly providerHealth?: ProviderHealthShape;
    readonly providerService?: ProviderServiceShape;
    readonly open?: OpenShape;
    readonly terminalManager?: TerminalManagerShape;
  } = {},
  run: (context: TestServerContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, never, never> {
  const stateDir = options.stateDir ?? makeTempDir("t3code-rpc-state-");
  const serverConfig = {
    mode: "web",
    port: 0,
    host: undefined,
    cwd: options.cwd ?? "/test/project",
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    stateDir,
    staticDir: options.staticDir,
    devUrl: undefined,
    noBrowser: true,
    authToken: options.authToken,
    autoBootstrapProjectFromCwd: options.autoBootstrapProjectFromCwd ?? false,
    logWebSocketEvents: false,
  } satisfies ServerConfigShape;
  const servicesLayer = makeTestServicesLayer({
    providerHealth: options.providerHealth ?? defaultProviderHealthService,
    providerService: options.providerService ?? defaultProviderService,
    open: options.open ?? defaultOpenService,
    ...(options.terminalManager ? { terminalManager: options.terminalManager } : {}),
  });
  const appLayer = makeServerAppLayer(servicesLayer);

  return Effect.gen(function* () {
    const testServer = yield* Layer.build(NodeHttpServer.layerTest).pipe(Effect.orDie);
    yield* Layer.build(appLayer).pipe(
      Effect.provide(testServer),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.orDie,
    );

    const server = yield* HttpServer.HttpServer.asEffect().pipe(Effect.provide(testServer));
    const client = yield* HttpClient.HttpClient.asEffect().pipe(Effect.provide(testServer));
    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.die(new Error("Expected TCP test server address"));
    }

    const tokenSuffix = options.authToken ? `?token=${options.authToken}` : "";
    return yield* run({
      client,
      wsUrl: `ws://127.0.0.1:${server.address.port}/ws${tokenSuffix}`,
    });
  }).pipe(Effect.scoped, Effect.orDie) as Effect.Effect<A, never, never>;
}

describe("wsServer", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("serves the health route through the exported app layer", async () => {
    await Effect.runPromise(
      withTestServer({}, ({ client }) =>
        Effect.gen(function* () {
          const response = yield* client.get("/health").pipe(Effect.orDie);
          const body = yield* response.text;
          expect(response.status).toBe(200);
          expect(JSON.parse(body)).toEqual({ ok: true });
        }),
      ),
    );
  });

  it("exposes bootstrap state and orchestration snapshot over websocket rpc", async () => {
    await Effect.runPromise(
      withTestServer(
        {
          cwd: "/workspace/example-project",
          autoBootstrapProjectFromCwd: true,
        },
        ({ wsUrl }) =>
          withRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const bootstrap = yield* client.getBootstrap(undefined);
              expect(bootstrap.cwd).toBe("/workspace/example-project");
              expect(bootstrap.projectName).toBe("example-project");
              expect(bootstrap.bootstrapProjectId).toBeDefined();
              expect(bootstrap.bootstrapThreadId).toBeDefined();

              const snapshot = yield* getSnapshotEffect(client);
              expect(snapshot.projects).toHaveLength(1);
              expect(snapshot.threads).toHaveLength(1);
              expect(snapshot.projects[0]?.workspaceRoot).toBe("/workspace/example-project");
              expect(snapshot.threads[0]?.projectId).toBe(bootstrap.bootstrapProjectId);
              expect(snapshot.threads[0]?.interactionMode).toBe(
                DEFAULT_PROVIDER_INTERACTION_MODE,
              );
              expect(snapshot.threads[0]?.runtimeMode).toBe("full-access");
            }),
          ),
      ),
    );
  });

  it("opens a terminal over rpc", async () => {
    await Effect.runPromise(
      withTestServer(
        {
          terminalManager: new MockTerminalManager(),
        },
        ({ wsUrl }) =>
          withRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const snapshot = yield* client.terminalOpen({
                threadId: "thread-1",
                terminalId: DEFAULT_TERMINAL_ID,
                cwd: "/tmp/test-terminal",
              });
              expect(snapshot.terminalId).toBe(DEFAULT_TERMINAL_ID);
              expect(snapshot.threadId).toBe("thread-1");
              expect(snapshot.cwd).toBe("/tmp/test-terminal");
              expect(snapshot.status).toBe("running");
            }),
          ),
      ),
    );
  });

  it("updates keybindings and emits config updates over rpc", async () => {
    await Effect.runPromise(
      withTestServer({}, ({ wsUrl }) =>
        withRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const initial = yield* getServerConfigEffect(client);
            expect(initial.keybindings.length).toBeGreaterThan(0);

            const updatesFiber = yield* client.subscribeServerConfig(undefined).pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkChild,
            );

            const updated = yield* upsertKeybindingEffect(client);
            expect(updated.issues).toEqual([]);

            const updates = yield* Fiber.join(updatesFiber);
            expect(updates[0]?.issues).toEqual([]);
            expect(updates[0]?.providers).toEqual(defaultProviderStatuses);

            const refreshed = yield* getServerConfigEffect(client);
            expect(
              refreshed.keybindings.some(
                (binding) => binding.command === "chat.new" && binding.shortcut.key === "y",
              ),
            ).toBe(true);
          }),
        ),
      ),
    );
  });
});
