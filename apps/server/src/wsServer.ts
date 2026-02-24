import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  CheckpointRef,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Layer, ManagedRuntime, Schema, Scope, ServiceMap, Stream } from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./gitManager";
import {
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  initGitRepo,
  listGitBranches,
  pullGitBranch,
  removeGitWorktree,
} from "./git";
import { TerminalManager } from "./terminalManager";
import { loadResolvedKeybindingsConfig, upsertKeybindingRule } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import assert from "node:assert";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "./checkpointing/Services/CheckpointStore";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Migrator from "effect/unstable/sql/Migrator";
import { clamp } from "effect/Number";
import { OpenDefaultService, type OpenShape } from "./open";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

export interface ServerOptions {
  port: number;
  host?: string | undefined;
  cwd: string;
  autoBootstrapProjectFromCwd?: boolean | undefined;
  stateDir?: string | undefined;
  persistenceLayer?:
    | Layer.Layer<SqlClient.SqlClient, SqlError.SqlError | Migrator.MigrationError>
    | undefined;
  staticDir?: string | undefined;
  devUrl?: string | undefined;
  logWebSocketEvents?: boolean | undefined;
  gitManager?: GitManager | undefined;
  terminalManager?: TerminalManager | undefined;
  providerLayer?: Layer.Layer<ProviderService, unknown> | undefined;
  authToken?: string | undefined;
  open?: OpenShape | undefined;
}

export interface ServerRuntime {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly httpServer: http.Server;
}

export interface ServerShape {
  readonly createServer: (options: ServerOptions) => ServerRuntime;
  readonly stopSignal: Effect.Effect<unknown, never>;
}

export class Server extends ServiceMap.Service<Server, ServerShape>()("server/Server") {}

export const ServerLive = Layer.succeed(Server, {
  createServer,
  stopSignal: Effect.never,
} satisfies ServerShape);

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
  socket.destroy();
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function stripRequestTag<T extends { _tag: string }>(body: T): Omit<T, "_tag"> {
  const { _tag: _ignoredTag, ...rest } = body;
  return rest;
}

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

function checkpointRefForThreadTurn(threadId: string, turnCount: number): CheckpointRef {
  const encodedThreadId = Buffer.from(threadId, "utf8").toString("base64url");
  return CheckpointRef.makeUnsafe(`${CHECKPOINT_REFS_PREFIX}/${encodedThreadId}/turn/${turnCount}`);
}

type EffectRuntime = ManagedRuntime.ManagedRuntime<
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | ProviderService
  | CheckpointStore
  | OrchestrationReactor,
  unknown
>;

export function createServer(options: ServerOptions): ServerRuntime {
  const {
    port,
    host,
    cwd,
    autoBootstrapProjectFromCwd = false,
    stateDir,
    persistenceLayer: customPersistenceLayer,
    staticDir,
    devUrl,
    logWebSocketEvents: explicitLogWsEvents,
    gitManager = new GitManager(),
    terminalManager = new TerminalManager(),
    providerLayer: customProviderLayer,
    authToken,
    open: openService = OpenDefaultService,
  } = options;

  const resolvedStateDir = stateDir ?? path.join(os.homedir(), ".t3", "userdata");
  let effectRuntime: EffectRuntime | null = null;
  let orchestrationEngine: OrchestrationEngineShape | null = null;
  let projectionSnapshotQuery: ProjectionSnapshotQueryShape | null = null;
  let providerService: ProviderServiceShape | null = null;
  let checkpointStore: CheckpointStoreShape | null = null;
  const clients = new Set<WebSocket>();
  const logger = createLogger("ws");
  const logWebSocketEvents =
    explicitLogWsEvents ?? parseBooleanEnv(process.env.T3CODE_LOG_WS_EVENTS) ?? Boolean(devUrl);
  let keybindingsConfig = loadResolvedKeybindingsConfig(logger);
  let orchestrationDomainEventLogger: EventNdjsonLogger | undefined;
  let orchestrationCommandLogger: EventNdjsonLogger | undefined;
  let subscriptionsScope: Scope.Closeable | null = null;

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const getOrchestrationEngine = () => {
    assert(orchestrationEngine, "Orchestration engine is not started");
    return orchestrationEngine;
  };

  const getEffectRuntime = () => {
    assert(effectRuntime, "Effect runtime is not started");
    return effectRuntime;
  };

  const getProjectionSnapshotQuery = () => {
    assert(projectionSnapshotQuery, "Projection snapshot query is not started");
    return projectionSnapshotQuery;
  };

  const getCheckpointStore = () => {
    assert(checkpointStore, "Checkpoint store is not started");
    return checkpointStore;
  };

  async function bootstrapProjectForCwd() {
    if (!autoBootstrapProjectFromCwd) {
      return;
    }

    const runtime = getEffectRuntime();
    const snapshotQuery = getProjectionSnapshotQuery();
    const engine = getOrchestrationEngine();
    const snapshot = await runtime.runPromise(snapshotQuery.getSnapshot());
    const existing = snapshot.projects.find((project) => project.workspaceRoot === cwd);
    if (existing) {
      return;
    }

    const createdAt = new Date().toISOString();
    const projectName = path.basename(cwd) || "project";
    await runtime.runPromise(
      engine.dispatchUnknownCommand({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        title: projectName,
        workspaceRoot: cwd,
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
  }

  const attachSubscriptionss = Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const orchestrationReactor = yield* OrchestrationReactor;
    subscriptionsScope = yield* Scope.make("sequential");

    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
      Effect.sync(() => {
        orchestrationDomainEventLogger?.write({
          observedAt: new Date().toISOString(),
          event,
        });
        const push: WsPush = {
          type: "push",
          channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
          data: event,
        };
        const message = JSON.stringify(push);
        let recipients = 0;
        for (const client of clients) {
          if (client.readyState === client.OPEN) {
            client.send(message);
            recipients += 1;
          }
        }
        logOutgoingPush(push, recipients);
      }),
    ).pipe(Effect.forkIn(subscriptionsScope));

    yield* orchestrationReactor.start.pipe(Scope.provide(subscriptionsScope));
  });

  const onTerminalEvent = (event: TerminalEvent) => {
    const push: WsPush = {
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    };
    const message = JSON.stringify(push);
    let recipients = 0;
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  };
  terminalManager.on("event", onTerminalEvent);

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    // In dev mode, redirect to Vite dev server
    if (devUrl) {
      res.writeHead(302, { Location: devUrl });
      res.end();
      return;
    }

    // Serve static files from the web app build
    if (!staticDir) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("No static directory configured and no dev URL set.");
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    let filePath = path.join(staticDir, url.pathname);

    // SPA fallback: if no file extension and not found, serve index.html
    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.join(filePath, "index.html");
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats?.isFile()) {
        // SPA fallback
        const indexPath = path.join(staticDir, "index.html");
        fs.readFile(indexPath, (readErr, data) => {
          if (readErr) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(data);
        });
        return;
      }

      const fileExt = path.extname(filePath);
      const contentType = MIME_TYPES[fileExt] ?? "application/octet-stream";

      fs.readFile(filePath, (readErr, data) => {
        if (readErr) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
          return;
        }
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      });
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Send welcome message with project info
    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcome: WsPush = {
      type: "push",
      channel: WS_CHANNELS.serverWelcome,
      data: { cwd, projectName },
    };
    logOutgoingPush(welcome, 1);
    ws.send(JSON.stringify(welcome));

    ws.on("message", (raw) => {
      void handleMessage(ws, raw);
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  async function handleMessage(ws: WebSocket, raw: unknown) {
    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse: WsResponse = {
        id: "unknown",
        error: { message: "Invalid request format" },
      };
      ws.send(JSON.stringify(errorResponse));
      return;
    }

    let request: WebSocketRequest;
    try {
      request = Schema.decodeUnknownSync(Schema.fromJsonString(WebSocketRequest))(messageText);
    } catch {
      const errorResponse: WsResponse = {
        id: "unknown",
        error: { message: "Invalid request format" },
      };
      ws.send(JSON.stringify(errorResponse));
      return;
    }

    try {
      const result = await routeRequest(request);
      const response: WsResponse = { id: request.id, result };
      ws.send(JSON.stringify(response));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown server error";
      const response: WsResponse = {
        id: request.id,
        error: { message },
      };
      ws.send(JSON.stringify(response));
    }
  }

  async function routeRequest(request: WebSocketRequest): Promise<unknown> {
    const orchestrationEngine = getOrchestrationEngine();
    const projectionReadModelQuery = getProjectionSnapshotQuery();
    const effectRuntime = getEffectRuntime();
    const liveCheckpointStore = getCheckpointStore();

    const computeTurnDiff = async (input: {
      readonly threadId: string;
      readonly fromTurnCount: number;
      readonly toTurnCount: number;
    }) => {
      if (input.fromTurnCount > input.toTurnCount) {
        throw new Error(
          `Invalid turn diff range for thread '${input.threadId}': from ${input.fromTurnCount} exceeds to ${input.toTurnCount}.`,
        );
      }

      if (input.fromTurnCount === input.toTurnCount) {
        return {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
      }

      const snapshot = await effectRuntime.runPromise(projectionReadModelQuery.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        throw new Error(`Thread '${input.threadId}' not found.`);
      }

      const maxTurnCount = thread.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        throw new Error(
          `Turn diff range exceeds current turn count for thread '${input.threadId}': requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        );
      }

      const workspaceCwd =
        thread.worktreePath?.trim() ||
        snapshot.projects.find((project) => project.id === thread.projectId)?.workspaceRoot?.trim();
      if (!workspaceCwd) {
        throw new Error(
          `Invariant violation: workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        );
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        throw new Error(
          `Checkpoint is unavailable for turn ${input.fromTurnCount} in thread ${input.threadId}.`,
        );
      }

      const toCheckpointRef = thread.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        throw new Error(
          `Checkpoint is unavailable for turn ${input.toTurnCount} in thread ${input.threadId}.`,
        );
      }

      const [fromExists, toExists] = await Promise.all([
        effectRuntime.runPromise(
          liveCheckpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: fromCheckpointRef,
          }),
        ),
        effectRuntime.runPromise(
          liveCheckpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: toCheckpointRef,
          }),
        ),
      ]);
      if (!fromExists) {
        throw new Error(
          `Filesystem checkpoint is unavailable for turn ${input.fromTurnCount} in thread ${input.threadId}.`,
        );
      }
      if (!toExists) {
        throw new Error(
          `Filesystem checkpoint is unavailable for turn ${input.toTurnCount} in thread ${input.threadId}.`,
        );
      }

      const diff = await effectRuntime.runPromise(
        liveCheckpointStore.diffCheckpoints({
          cwd: workspaceCwd,
          fromCheckpointRef,
          toCheckpointRef,
          fallbackFromToHead: false,
        }),
      );
      return {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
    };

    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot: {
        return effectRuntime.runPromise(projectionReadModelQuery.getSnapshot());
      }

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        orchestrationCommandLogger?.write({
          observedAt: new Date().toISOString(),
          command: request.body.command,
        });
        return effectRuntime.runPromise(orchestrationEngine.dispatch(request.body.command));
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return computeTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return computeTurnDiff({
          threadId: body.threadId,
          fromTurnCount: 0,
          toTurnCount: body.toTurnCount,
        });
      }

      case ORCHESTRATION_WS_METHODS.replayEvents:
        return effectRuntime.runPromise(
          Stream.runCollect(
            orchestrationEngine.readEvents(
              clamp(request.body.fromSequenceExclusive, {
                maximum: Number.MAX_SAFE_INTEGER,
                minimum: 0,
              }),
            ),
          ).pipe(Effect.map((events) => Array.from(events))),
        );

      case WS_METHODS.projectsSearchEntries:
        return searchWorkspaceEntries(stripRequestTag(request.body));

      case WS_METHODS.shellOpenInEditor: {
        await Effect.runPromise(openService.openInEditor(stripRequestTag(request.body)));
        return undefined;
      }

      case WS_METHODS.gitStatus:
        return gitManager.status(stripRequestTag(request.body));

      case WS_METHODS.gitPull:
        return pullGitBranch(stripRequestTag(request.body));

      case WS_METHODS.gitRunStackedAction:
        return gitManager.runStackedAction(stripRequestTag(request.body));
      case WS_METHODS.gitListBranches:
        return listGitBranches(stripRequestTag(request.body));

      case WS_METHODS.gitCreateWorktree:
        return createGitWorktree(stripRequestTag(request.body));

      case WS_METHODS.gitRemoveWorktree:
        return removeGitWorktree(stripRequestTag(request.body));

      case WS_METHODS.gitCreateBranch:
        return createGitBranch(stripRequestTag(request.body));

      case WS_METHODS.gitCheckout:
        return checkoutGitBranch(stripRequestTag(request.body));

      case WS_METHODS.gitInit:
        return initGitRepo(stripRequestTag(request.body));

      case WS_METHODS.terminalOpen:
        return terminalManager.open(stripRequestTag(request.body));

      case WS_METHODS.terminalWrite:
        await terminalManager.write(stripRequestTag(request.body));
        return undefined;

      case WS_METHODS.terminalResize:
        await terminalManager.resize(stripRequestTag(request.body));
        return undefined;

      case WS_METHODS.terminalClear:
        await terminalManager.clear(stripRequestTag(request.body));
        return undefined;

      case WS_METHODS.terminalRestart:
        return terminalManager.restart(stripRequestTag(request.body));

      case WS_METHODS.terminalClose:
        await terminalManager.close(stripRequestTag(request.body));
        return undefined;

      case WS_METHODS.serverGetConfig:
        return {
          cwd,
          keybindings: keybindingsConfig,
        };

      case WS_METHODS.serverUpsertKeybinding:
        keybindingsConfig = upsertKeybindingRule(logger, stripRequestTag(request.body));
        return {
          keybindings: keybindingsConfig,
        };

      default: {
        const _exhaustiveCheck: never = request.body;
        throw new Error(`Unknown method: ${String(_exhaustiveCheck)}`);
      }
    }
  }

  async function createEffectRuntime() {
    const dbPath = path.join(resolvedStateDir, "orchestration.sqlite");
    const providerLogsDir = path.join(resolvedStateDir, "logs", "providers");
    const orchestrationLogsDir = path.join(resolvedStateDir, "logs", "orchestration");
    orchestrationDomainEventLogger = makeEventNdjsonLogger(
      path.join(orchestrationLogsDir, "orchestration-domain.ndjson"),
    );
    orchestrationCommandLogger = makeEventNdjsonLogger(
      path.join(orchestrationLogsDir, "orchestration-command.ndjson"),
    );
    const persistenceLayer = customPersistenceLayer ?? makeSqlitePersistenceLive(dbPath);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(NodeServices.layer));
    const providerLayer =
      customProviderLayer ??
      (() => {
        const codexAdapterLayer = makeCodexAdapterLive({
          nativeEventLogPath: path.join(providerLogsDir, "provider-native.ndjson"),
        });
        const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
          Layer.provide(codexAdapterLayer),
        );
        const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(ProviderSessionRuntimeRepositoryLive),
        );
        return makeProviderServiceLive({
          canonicalEventLogPath: path.join(providerLogsDir, "provider-canonical.ndjson"),
        }).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
      })();

    const runtimeServicesLayer = Layer.mergeAll(
      orchestrationLayer,
      OrchestrationProjectionSnapshotQueryLive,
      checkpointStoreLayer,
      providerLayer,
    );
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
    );
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
    );
    const checkpointReactorLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
    );
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
      Layer.provideMerge(checkpointReactorLayer),
    );
    const layer = orchestrationReactorLayer.pipe(
      Layer.provide(persistenceLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);

    try {
      const [
        nextOrchestrationEngine,
        nextProjectionSnapshotQuery,
        nextCheckpointStore,
        nextProviderService,
      ] = await Promise.all([
        runtime.runPromise(Effect.service(OrchestrationEngineService)),
        runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
        runtime.runPromise(Effect.service(CheckpointStore)),
        runtime.runPromise(Effect.service(ProviderService)),
      ]);
      orchestrationEngine = nextOrchestrationEngine;
      projectionSnapshotQuery = nextProjectionSnapshotQuery;
      checkpointStore = nextCheckpointStore;
      providerService = nextProviderService;
      await runtime.runPromise(attachSubscriptionss);
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }

    return runtime;
  }

  async function disposeEffectRuntime() {
    if (subscriptionsScope && effectRuntime) {
      await effectRuntime.runPromise(Scope.close(subscriptionsScope, Exit.void));
      subscriptionsScope = null;
    }
    orchestrationDomainEventLogger?.close();
    orchestrationDomainEventLogger = undefined;
    orchestrationCommandLogger?.close();
    orchestrationCommandLogger = undefined;

    const runtime = effectRuntime;
    const liveProviderService = providerService;
    effectRuntime = null;
    orchestrationEngine = null;
    projectionSnapshotQuery = null;
    checkpointStore = null;
    providerService = null;

    if (!runtime) {
      return;
    }

    if (liveProviderService) {
      await runtime.runPromise(liveProviderService.stopAll()).catch(() => undefined);
    }

    await runtime.dispose();
  }

  async function start() {
    effectRuntime = await createEffectRuntime();
    await bootstrapProjectForCwd();

    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("error", onError);
        void disposeEffectRuntime().finally(() => reject(error));
      };
      httpServer.once("error", onError);
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      if (host) {
        httpServer.listen(port, host, onListening);
        return;
      }
      httpServer.listen(port, onListening);
    });
  }

  async function stop(): Promise<void> {
    await disposeEffectRuntime();
    terminalManager.off("event", onTerminalEvent);
    terminalManager.dispose();

    for (const client of clients) {
      client.close();
    }
    clients.clear();

    const closeWebSocketServer = new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error && !isServerNotRunningError(error)) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const closeHttpServer = new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error && !isServerNotRunningError(error)) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await Promise.all([closeWebSocketServer, closeHttpServer]);
  }

  return { start, stop, httpServer };
}
