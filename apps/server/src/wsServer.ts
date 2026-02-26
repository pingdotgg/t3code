/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  CommandId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Ref, Schema, Scope, ServiceMap, Stream, Struct } from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";

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

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    unknown,
    Scope.Scope | ServerRuntimeServices | ServerConfig
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<unknown, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("server/Server") {}

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
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

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open;

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

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  unknown, // TODO: This should not be unknown
  Scope.Scope | ServerRuntimeServices | ServerConfig
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const git = yield* GitCore;

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    const push: WsPush = {
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    };
    const message = yield* Schema.encodeEffect(Schema.fromJsonString(WsPush))(push);
    let recipients = 0;
    for (const client of yield* Ref.get(clients)) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    // In dev mode, redirect to Vite dev server
    if (devUrl) {
      res.writeHead(302, { Location: devUrl.href });
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

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const liveProviderService = yield* ProviderService;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    Effect.gen(function* () {
      const push: WsPush = {
        type: "push",
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: event,
      };
      const message = yield* Schema.encodeEffect(Schema.fromJsonString(WsPush))(push);
      let recipients = 0;
      for (const client of yield* Ref.get(clients)) {
        if (client.readyState === client.OPEN) {
          client.send(message);
          recipients += 1;
        }
      }
      logOutgoingPush(push, recipients);
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);

  if (autoBootstrapProjectFromCwd) {
    const snapshot = yield* projectionReadModelQuery.getSnapshot();
    const existing = snapshot.projects.find((project) => project.workspaceRoot === cwd);
    if (!existing) {
      const createdAt = new Date().toISOString();
      const projectName = path.basename(cwd) || "project";
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId: ProjectId.makeUnsafe(crypto.randomUUID()),
        title: projectName,
        workspaceRoot: cwd,
        defaultModel: "gpt-5-codex",
        createdAt,
      });
    }
  }

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        return yield* orchestrationEngine.dispatch(command);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
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
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* git.checkoutBranch(body);
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadResolvedKeybindingsConfig;
        return { cwd, keybindings: keybindingsConfig };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
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
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${Cause.pretty(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: Cause.pretty(result.cause) },
      });
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse({
      id: request.value.id,
      result: result.value,
    });
    ws.send(response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

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
    void Effect.runPromise(Ref.update(clients, (clients) => clients.add(ws)));

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
      void Effect.runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) => Effect.logError("Error handling message", error)),
        ),
      );
    });

    ws.on("close", () => {
      void Effect.runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void Effect.runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(liveProviderService.stopAll(), (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  yield* NodeHttpServer.make(() => httpServer, listenOptions);

  yield* Effect.addFinalizer(() =>
    Effect.all([
      closeAllClients,
      closeWebSocketServer.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close web socket server", { cause: error }),
        ),
      ),
    ]),
  );

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
