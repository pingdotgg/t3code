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
  WebSocketResponse,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Schema, Scope, ServiceMap, Stream } from "effect";
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
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderService } from "./provider/Services/ProviderService";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
  staticDir?: string | undefined;
  devUrl?: string | undefined;
  logWebSocketEvents?: boolean | undefined;
  gitManager?: GitManager | undefined;
  terminalManager?: TerminalManager | undefined;
  authToken?: string | undefined;
  open?: OpenShape | undefined;
}

export interface ServerShape {
  readonly createServer: (
    options: ServerOptions,
  ) => Effect.Effect<http.Server, unknown, Scope.Scope | ServerRuntimeServices>;
  readonly stopSignal: Effect.Effect<unknown, never>;
}

export class Server extends ServiceMap.Service<Server, ServerShape>()("server/Server") {}

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

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointStore
  | OrchestrationReactor;

export type ServerRuntimeServices = ServerCoreRuntimeServices | ProviderService;

export function makeServerPersistenceLayer(stateDir: string) {
  const dbPath = path.join(stateDir, "orchestration.sqlite");
  return makeSqlitePersistenceLive(dbPath);
}

export function makeServerProviderLayer(
  stateDir: string,
): Layer.Layer<ProviderService, unknown, SqlClient.SqlClient> {
  const providerLogsDir = path.join(stateDir, "logs", "providers");
  const codexAdapterLayer = makeCodexAdapterLive({
    nativeEventLogPath: path.join(providerLogsDir, "provider-native.ndjson"),
  });
  const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(Layer.provide(codexAdapterLayer));
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  return makeProviderServiceLive({
    canonicalEventLogPath: path.join(providerLogsDir, "provider-canonical.ndjson"),
  }).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
}

export function makeServerRuntimeServicesLayer(): Layer.Layer<
  ServerCoreRuntimeServices,
  unknown,
  SqlClient.SqlClient | ProviderService
> {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(NodeServices.layer));

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    checkpointStoreLayer,
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

  return orchestrationReactorLayer;
}

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (
  options: ServerOptions,
): Effect.fn.Return<http.Server, unknown, Scope.Scope | ServerRuntimeServices> {
  const {
    port,
    host,
    cwd,
    autoBootstrapProjectFromCwd = false,
    staticDir,
    devUrl,
    logWebSocketEvents: explicitLogWsEvents,
    gitManager = new GitManager(),
    terminalManager = new TerminalManager(),
    authToken,
    open: openService = OpenDefaultService,
  } = options;

  const clients = new Set<WebSocket>();
  const logger = createLogger("ws");
  const logWebSocketEvents =
    explicitLogWsEvents ?? parseBooleanEnv(process.env.T3CODE_LOG_WS_EVENTS) ?? Boolean(devUrl);
  let keybindingsConfig = loadResolvedKeybindingsConfig(logger);

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

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

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = () => {
    for (const client of clients) {
      client.close();
    }
    clients.clear();
  };

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const liveCheckpointStore = yield* CheckpointStore;
  const liveProviderService = yield* ProviderService;
  const orchestrationReactor = yield* OrchestrationReactor;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() =>
    Scope.close(subscriptionsScope, Exit.void).pipe(Effect.orElseSucceed(() => undefined)),
  );

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    Effect.sync(() => {
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

  if (autoBootstrapProjectFromCwd) {
    const snapshot = yield* projectionReadModelQuery.getSnapshot();
    const existing = snapshot.projects.find((project) => project.workspaceRoot === cwd);
    if (!existing) {
      const createdAt = new Date().toISOString();
      const projectName = path.basename(cwd) || "project";
      yield* orchestrationEngine.dispatchUnknownCommand({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        title: projectName,
        workspaceRoot: cwd,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
    }
  }

  const routeRequest = Effect.fn(function* (request: WebSocketRequest) {
    const computeTurnDiff = Effect.fn(function* (input: {
      readonly threadId: string;
      readonly fromTurnCount: number;
      readonly toTurnCount: number;
    }) {
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

      const snapshot = yield* projectionReadModelQuery.getSnapshot();
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

      const [fromExists, toExists] = yield* Effect.all(
        [
          liveCheckpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: fromCheckpointRef,
          }),
          liveCheckpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: toCheckpointRef,
          }),
        ],
        { concurrency: "unbounded" },
      );
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

      const diff = yield* liveCheckpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
      });
      return {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
    });

    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        return yield* orchestrationEngine.dispatch(command);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* computeTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* computeTurnDiff({
          threadId: body.threadId,
          fromTurnCount: 0,
          toTurnCount: body.toTurnCount,
        });
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => searchWorkspaceEntries(body));
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openService.openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => gitManager.status(body));
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => pullGitBranch(body));
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => gitManager.runStackedAction(body));
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => listGitBranches(body));
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => createGitWorktree(body));
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => removeGitWorktree(body));
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => createGitBranch(body));
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => checkoutGitBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => initGitRepo(body));
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => terminalManager.open(body));
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => terminalManager.write(body));
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => terminalManager.resize(body));
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => terminalManager.clear(body));
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => terminalManager.restart(body));
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* Effect.promise(() => terminalManager.close(body));
      }

      case WS_METHODS.serverGetConfig:
        return { cwd, keybindings: keybindingsConfig };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        keybindingsConfig = upsertKeybindingRule(logger, body);
        return { keybindings: keybindingsConfig };
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse = yield* encodeResponse(
        new WebSocketResponse({
          id: "unknown",
          error: { message: "Invalid request format: Failed to read message" },
        }),
      );
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse(
        new WebSocketResponse({
          id: "unknown",
          error: { message: `Invalid request format: ${Cause.pretty(request.cause)}` },
        }),
      );
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse(
        new WebSocketResponse({
          id: request.value.id,
          error: { message: Cause.pretty(result.cause) },
        }),
      );
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse(
      new WebSocketResponse({
        id: request.value.id,
        result: result.value,
      }),
    );
    ws.send(response);
  });

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
      void Effect.runPromise(handleMessage(ws, raw));
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(liveProviderService.stopAll(), (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  terminalManager.on("event", onTerminalEvent);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      terminalManager.off("event", onTerminalEvent);
      terminalManager.dispose();
    }),
  );

  yield* NodeHttpServer.make(() => httpServer, listenOptions);

  yield* Effect.addFinalizer(() =>
    Effect.all([
      Effect.sync(() => closeAllClients()),
      closeWebSocketServer.pipe(Effect.orElseSucceed(() => undefined)),
    ]),
  );

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  createServer,
  stopSignal: Effect.never,
} satisfies ServerShape);
