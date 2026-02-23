import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import {
  EDITORS,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  type ProviderRuntimeEvent,
  type TerminalEvent,
  type WsPush,
  type WsRequest,
  type WsResponse,
  wsRequestSchema,
} from "@t3tools/contracts";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream } from "effect";
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
import { OrchestrationEngineLive } from "./orchestration/Layer";
import { OrchestrationEngineService, type OrchestrationEngineShape } from "./orchestration/Service";
import { ProjectRepositoryLive } from "./persistence/Layers/Projects";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite";
import { ProjectRepository, type ProjectRepositoryShape } from "./persistence/Services/Projects";
import assert from "node:assert";
import { OrchestrationEventRepositoryLive } from "./persistence/Layers/OrchestrationEvents";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { CheckpointServiceLive } from "./checkpointing/Layers/CheckpointService";
import { parseTurnDiffFilesFromUnifiedDiff, type TurnDiffFileSummary } from "./checkpointing/Diffs";
import { CheckpointRepositoryLive } from "./persistence/Layers/Checkpoints";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Migrator from "effect/unstable/sql/Migrator";

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
  stateDir?: string | undefined;
  persistenceLayer?:
    | Layer.Layer<SqlClient.SqlClient, SqlError.SqlError | Migrator.MigrationError>
    | undefined;
  staticDir?: string | undefined;
  devUrl?: string | undefined;
  logWebSocketEvents?: boolean | undefined;
  gitManager?: GitManager | undefined;
  terminalManager?: TerminalManager | undefined;
  authToken?: string | undefined;
}

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

const providerTurnKey = (sessionId: string, turnId: string) => `${sessionId}:${turnId}`;

type ActivityTone = "thinking" | "tool" | "info" | "error";

interface ThreadActivityInput {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly detail?: string;
  readonly tone: ActivityTone;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly requestKind?: "command" | "file-change";
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function runtimeEventToActivities(event: ProviderRuntimeEvent): ReadonlyArray<ThreadActivityInput> {
  switch (event.type) {
    case "approval.requested":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label:
            event.requestKind === "command"
              ? "Command approval requested"
              : "File-change approval requested",
          ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          tone: "tool",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          requestId: event.requestId,
          requestKind: event.requestKind,
        },
      ];
    case "approval.resolved":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: "Approval resolved",
          tone: "info",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          requestId: event.requestId,
          ...(event.requestKind ? { requestKind: event.requestKind } : {}),
        },
      ];
    case "runtime.error":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: "Runtime error",
          detail: truncateDetail(event.message),
          tone: "error",
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      ];
    case "checkpoint.captured":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: "Checkpoint captured",
          tone: "info",
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      ];
    case "tool.completed":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          label: `${event.title} complete`,
          ...(event.detail ? { detail: truncateDetail(event.detail) } : {}),
          tone: "tool",
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      ];
    default:
      return [];
  }
}

const noop = () => {};

export function createServer(options: ServerOptions) {
  const {
    port,
    host,
    cwd,
    stateDir,
    persistenceLayer: customPersistenceLayer,
    staticDir,
    devUrl,
    logWebSocketEvents: explicitLogWsEvents,
    gitManager = new GitManager(),
    terminalManager = new TerminalManager(),
    authToken,
  } = options;

  const resolvedStateDir = stateDir ?? path.join(os.homedir(), ".t3", "userdata");
  let effectRuntime: ManagedRuntime.ManagedRuntime<
    ProjectRepository | OrchestrationEngineService | ProviderService,
    unknown
  > | null = null;
  let projectRepository: ProjectRepositoryShape | null = null;
  let orchestrationEngine: OrchestrationEngineShape | null = null;
  let providerService: ProviderServiceShape | null = null;
  const clients = new Set<WebSocket>();
  const logger = createLogger("ws");
  const logWebSocketEvents =
    explicitLogWsEvents ?? parseBooleanEnv(process.env.T3CODE_LOG_WS_EVENTS) ?? Boolean(devUrl);
  let keybindingsConfig = loadResolvedKeybindingsConfig(logger);
  let orchestrationDomainEventLogger: EventNdjsonLogger | undefined;
  let orchestrationCommandLogger: EventNdjsonLogger | undefined;
  let unsubscribeDomainEvents = noop;
  let unsubscribeProviderEvents = noop;

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

  const getProjectRepository = () => {
    assert(projectRepository, "Project repository is not started");
    return projectRepository;
  };

  const getEffectRuntime = () => {
    assert(effectRuntime, "Effect runtime is not started");
    return effectRuntime;
  };

  const getProviderService = () => {
    assert(providerService, "Provider service is not started");
    return providerService;
  };

  async function attachOrchestrationSubscriptions(
    runtime: ManagedRuntime.ManagedRuntime<
      ProjectRepository | OrchestrationEngineService | ProviderService,
      unknown
    >,
    orchestrationEngine: OrchestrationEngineShape,
  ) {
    const subscriptionScope = await runtime.runPromise(Scope.make("sequential"));
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
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
          ),
        );
      }).pipe(Scope.provide(subscriptionScope)),
    );

    unsubscribeDomainEvents = () => {
      runtime.runFork(Scope.close(subscriptionScope, Exit.void));
    };
  }

  async function attachProviderSubscriptions(
    runtime: ManagedRuntime.ManagedRuntime<
      ProjectRepository | OrchestrationEngineService | ProviderService,
      unknown
    >,
    providerService: ProviderServiceShape,
    orchestrationEngine: OrchestrationEngineShape,
  ) {
    const turnMessageIdsByTurnKey = new Map<string, Set<string>>();
    const latestMessageIdByTurnKey = new Map<string, string>();

    const rememberAssistantMessageId = (sessionId: string, turnId: string, messageId: string) => {
      const key = providerTurnKey(sessionId, turnId);
      const existingIds = turnMessageIdsByTurnKey.get(key);
      if (existingIds) {
        existingIds.add(messageId);
      } else {
        turnMessageIdsByTurnKey.set(key, new Set([messageId]));
      }
      latestMessageIdByTurnKey.set(key, messageId);
    };

    const getAssistantMessageIdsForTurn = (sessionId: string, turnId: string) => {
      return turnMessageIdsByTurnKey.get(providerTurnKey(sessionId, turnId)) ?? new Set<string>();
    };

    const clearAssistantMessageIdsForTurn = (sessionId: string, turnId: string) => {
      turnMessageIdsByTurnKey.delete(providerTurnKey(sessionId, turnId));
    };

    const getLatestAssistantMessageIdForTurn = (sessionId: string, turnId: string) => {
      return latestMessageIdByTurnKey.get(providerTurnKey(sessionId, turnId));
    };

    const clearTurnStateForSession = (sessionId: string) => {
      const prefix = `${sessionId}:`;
      for (const key of turnMessageIdsByTurnKey.keys()) {
        if (key.startsWith(prefix)) {
          turnMessageIdsByTurnKey.delete(key);
        }
      }
      for (const key of latestMessageIdByTurnKey.keys()) {
        if (key.startsWith(prefix)) {
          latestMessageIdByTurnKey.delete(key);
        }
      }
    };

    const processEvent = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getSnapshot();
        const thread = snapshot.threads.find(
          (entry) => entry.session?.sessionId === event.sessionId,
        );
        if (!thread) return;

        const now = event.createdAt;
        if (event.type === "turn.started" || event.type === "turn.completed") {
          yield* orchestrationEngine.dispatch({
            type: "thread.session",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            session: {
              sessionId: event.sessionId,
              provider: event.provider,
              status: event.type === "turn.started" ? "running" : "ready",
              threadId: thread.id,
              activeTurnId: event.type === "turn.started" ? event.turnId : null,
              createdAt: thread.session?.createdAt ?? now,
              updatedAt: now,
              lastError:
                event.type === "turn.completed" && event.status === "failed"
                  ? (event.errorMessage ?? null)
                  : null,
            },
            createdAt: now,
          });
        }

        if (event.type === "message.delta" && event.delta.length > 0) {
          const assistantMessageId = `assistant:${event.itemId ?? event.turnId ?? event.sessionId}`;
          if (event.turnId) {
            rememberAssistantMessageId(event.sessionId, event.turnId, assistantMessageId);
          }
          yield* orchestrationEngine.dispatch({
            type: "message.send",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            messageId: assistantMessageId,
            role: "assistant",
            text: event.delta,
            streaming: true,
            createdAt: now,
          });
        }

        if (event.type === "message.completed") {
          const assistantMessageId = `assistant:${event.itemId}`;
          if (event.turnId) {
            rememberAssistantMessageId(event.sessionId, event.turnId, assistantMessageId);
          }
          yield* orchestrationEngine.dispatch({
            type: "message.send",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            messageId: assistantMessageId,
            role: "assistant",
            text: "",
            streaming: false,
            createdAt: now,
          });
        }

        if (event.type === "turn.completed") {
          if (event.turnId) {
            const assistantMessageIds = getAssistantMessageIdsForTurn(
              event.sessionId,
              event.turnId,
            );
            yield* Effect.forEach(assistantMessageIds, (assistantMessageId) =>
              orchestrationEngine.dispatch({
                type: "message.send",
                commandId: crypto.randomUUID(),
                threadId: thread.id,
                messageId: assistantMessageId,
                role: "assistant",
                text: "",
                streaming: false,
                createdAt: now,
              }),
            ).pipe(Effect.asVoid);
            clearAssistantMessageIdsForTurn(event.sessionId, event.turnId);
          }
        }

        if (event.type === "session.exited") {
          clearTurnStateForSession(event.sessionId);
        }

        if (event.type === "checkpoint.captured" && event.turnId) {
          const files: ReadonlyArray<TurnDiffFileSummary> = yield* providerService
            .getCheckpointDiff({
              sessionId: event.sessionId,
              fromTurnCount: Math.max(0, event.turnCount - 1),
              toTurnCount: event.turnCount,
            })
            .pipe(
              Effect.map((result) => parseTurnDiffFilesFromUnifiedDiff(result.diff)),
              Effect.catch((error) =>
                Effect.sync(() => {
                  logger.warn("failed to derive checkpoint file summary", {
                    sessionId: event.sessionId,
                    turnId: event.turnId,
                    turnCount: event.turnCount,
                    error:
                      error instanceof Error
                        ? error.message
                        : typeof error === "string"
                          ? error
                          : "unknown error",
                  });
                }).pipe(Effect.as([] as ReadonlyArray<TurnDiffFileSummary>)),
              ),
            );
          const assistantMessageId =
            getLatestAssistantMessageIdForTurn(event.sessionId, event.turnId) ??
            `assistant:${event.turnId}`;
          yield* orchestrationEngine.dispatch({
            type: "thread.turnDiff.complete",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            turnId: event.turnId,
            completedAt: now,
            ...(event.status ? { status: event.status } : {}),
            files,
            assistantMessageId,
            checkpointTurnCount: event.turnCount,
            createdAt: now,
          });
        }

        if (event.type === "runtime.error") {
          yield* orchestrationEngine.dispatch({
            type: "thread.session",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            session: {
              sessionId: event.sessionId,
              provider: event.provider,
              status: "error",
              threadId: thread.id,
              activeTurnId: event.turnId ?? null,
              createdAt: thread.session?.createdAt ?? now,
              updatedAt: now,
              lastError: event.message,
            },
            createdAt: now,
          });
        }

        const activities = runtimeEventToActivities(event);
        yield* Effect.forEach(activities, (activity) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            activity,
            createdAt: activity.createdAt,
          }),
        ).pipe(Effect.asVoid);
      });

    const subscriptionScope = await runtime.runPromise(Scope.make("sequential"));
    await runtime.runPromise(
      Effect.gen(function* () {
        const providerEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

        yield* Effect.addFinalizer(() => Queue.shutdown(providerEventQueue).pipe(Effect.asVoid));

        yield* Effect.forkScoped(
          Effect.forever(Queue.take(providerEventQueue).pipe(Effect.flatMap(processEvent))),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(providerService.streamEvents, (event) =>
            Queue.offer(providerEventQueue, event).pipe(Effect.asVoid),
          ),
        );
      }).pipe(Scope.provide(subscriptionScope)),
    );

    unsubscribeProviderEvents = () => {
      runtime.runFork(Scope.close(subscriptionScope, Exit.void));
    };
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
    let request: WsRequest;
    try {
      const parsed = JSON.parse(String(raw));
      request = wsRequestSchema.parse(parsed);
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

  async function routeRequest(request: WsRequest): Promise<unknown> {
    const orchestrationEngine = getOrchestrationEngine();
    const projectRepository = getProjectRepository();
    const effectRuntime = getEffectRuntime();
    const providerService = getProviderService();

    switch (request.method) {
      case WS_METHODS.providersStartSession:
        return effectRuntime.runPromise(providerService.startSession(request.params as never));

      case WS_METHODS.providersSendTurn:
        return effectRuntime.runPromise(providerService.sendTurn(request.params as never));

      case WS_METHODS.providersInterruptTurn:
        return effectRuntime.runPromise(providerService.interruptTurn(request.params as never));

      case WS_METHODS.providersRespondToRequest:
        return effectRuntime.runPromise(providerService.respondToRequest(request.params as never));

      case WS_METHODS.providersStopSession: {
        await effectRuntime.runPromise(providerService.stopSession(request.params as never));
        return undefined;
      }

      case WS_METHODS.providersListCheckpoints:
        return effectRuntime.runPromise(providerService.listCheckpoints(request.params as never));

      case WS_METHODS.providersGetCheckpointDiff:
        return effectRuntime.runPromise(providerService.getCheckpointDiff(request.params as never));

      case WS_METHODS.providersRevertToCheckpoint: {
        const result = await effectRuntime.runPromise(
          providerService.revertToCheckpoint(request.params as never),
        );
        const params = request.params as { sessionId?: string };
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") {
          const snapshot = await effectRuntime.runPromise(orchestrationEngine.getSnapshot());
          const thread = snapshot.threads.find((entry) => entry.session?.sessionId === sessionId);
          if (thread) {
            const now = new Date().toISOString();
            await effectRuntime.runPromise(
              orchestrationEngine.dispatch({
                type: "thread.revert",
                commandId: crypto.randomUUID(),
                threadId: thread.id,
                turnCount: result.turnCount,
                messageCount: result.messageCount,
                createdAt: now,
              }),
            );
            if (thread.session) {
              await effectRuntime.runPromise(
                orchestrationEngine.dispatch({
                  type: "thread.session",
                  commandId: crypto.randomUUID(),
                  threadId: thread.id,
                  session: {
                    ...thread.session,
                    status: "ready",
                    activeTurnId: null,
                    updatedAt: now,
                    lastError: null,
                  },
                  createdAt: now,
                }),
              );
            }
          }
        }
        return result;
      }

      case WS_METHODS.projectsList:
        return effectRuntime.runPromise(projectRepository.list());

      case WS_METHODS.projectsAdd:
        return effectRuntime.runPromise(projectRepository.add(request.params as never));

      case WS_METHODS.projectsRemove:
        return effectRuntime.runPromise(projectRepository.remove(request.params as never));

      case WS_METHODS.projectsSearchEntries:
        return searchWorkspaceEntries(request.params as never);
      case WS_METHODS.projectsUpdateScripts:
        return effectRuntime.runPromise(projectRepository.updateScripts(request.params as never));

      case WS_METHODS.shellOpenInEditor: {
        const params = request.params as {
          cwd: string;
          editor: string;
        };
        if (!params?.cwd) throw new Error("cwd is required");
        const editorDef = EDITORS.find((e) => e.id === params.editor);
        if (!editorDef) throw new Error(`Unknown editor: ${params.editor}`);

        let command: string;
        let args: string[];

        if (editorDef.command) {
          command = editorDef.command;
          args = [params.cwd];
        } else if (editorDef.id === "file-manager") {
          // Use platform-specific file manager command
          switch (process.platform) {
            case "darwin":
              command = "open";
              break;
            case "win32":
              command = "explorer";
              break;
            default:
              command = "xdg-open";
              break;
          }
          args = [params.cwd];
        } else {
          return undefined;
        }

        const child = spawn(command, args, {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {
          /* ignore spawn failures for detached editors */
        });
        child.unref();
        return undefined;
      }

      case WS_METHODS.gitStatus: {
        const params = request.params as { cwd: string };
        const status = await gitManager.status(request.params as never);
        const projects = await effectRuntime.runPromise(projectRepository.list());
        const project = projects.find((entry) => entry.cwd === params.cwd);
        if (project) {
          await effectRuntime.runPromise(
            orchestrationEngine.dispatch({
              type: "git.readModel.upsert",
              commandId: crypto.randomUUID(),
              projectId: project.id,
              branch: status.branch,
              hasWorkingTreeChanges: status.hasWorkingTreeChanges,
              aheadCount: status.aheadCount,
              behindCount: status.behindCount,
              createdAt: new Date().toISOString(),
            }),
          );
        }
        return status;
      }

      case WS_METHODS.gitPull:
        return pullGitBranch(request.params as never);

      case WS_METHODS.gitRunStackedAction:
        return gitManager.runStackedAction(request.params as never);
      case WS_METHODS.gitListBranches:
        return listGitBranches(request.params as never);

      case WS_METHODS.gitCreateWorktree:
        return createGitWorktree(request.params as never);

      case WS_METHODS.gitRemoveWorktree:
        return removeGitWorktree(request.params as never);

      case WS_METHODS.gitCreateBranch:
        return createGitBranch(request.params as never);

      case WS_METHODS.gitCheckout:
        return checkoutGitBranch(request.params as never);

      case WS_METHODS.gitInit:
        return initGitRepo(request.params as never);

      case WS_METHODS.terminalOpen:
        return terminalManager.open(request.params as never);

      case WS_METHODS.terminalWrite:
        await terminalManager.write(request.params as never);
        return undefined;

      case WS_METHODS.terminalResize:
        await terminalManager.resize(request.params as never);
        return undefined;

      case WS_METHODS.terminalClear:
        await terminalManager.clear(request.params as never);
        return undefined;

      case WS_METHODS.terminalRestart:
        return terminalManager.restart(request.params as never);

      case WS_METHODS.terminalClose:
        await terminalManager.close(request.params as never);
        return undefined;

      case WS_METHODS.serverGetConfig:
        return {
          cwd,
          keybindings: keybindingsConfig,
        };

      case WS_METHODS.serverUpsertKeybinding:
        keybindingsConfig = upsertKeybindingRule(logger, request.params);
        return {
          keybindings: keybindingsConfig,
        };

      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return effectRuntime.runPromise(orchestrationEngine.getSnapshot());

      case ORCHESTRATION_WS_METHODS.dispatchCommand:
        orchestrationCommandLogger?.write({
          observedAt: new Date().toISOString(),
          requestId: request.id,
          command: request.params,
        });
        return effectRuntime.runPromise(orchestrationEngine.dispatchUnknown(request.params));

      case ORCHESTRATION_WS_METHODS.replayEvents:
        return effectRuntime.runPromise(
          orchestrationEngine.replayEvents(
            Math.max(
              0,
              Math.floor(
                Number(
                  (request.params as { fromSequenceExclusive?: number } | undefined)
                    ?.fromSequenceExclusive ?? 0,
                ),
              ),
            ),
          ),
        );

      default:
        throw new Error(`Unknown method: ${request.method}`);
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
    const orchestrationLayer = Layer.provide(
      OrchestrationEngineLive,
      OrchestrationEventRepositoryLive,
    );
    const codexAdapterLayer = makeCodexAdapterLive({
      nativeEventLogPath: path.join(providerLogsDir, "provider-native.ndjson"),
    });
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(Layer.provide(codexAdapterLayer));
    const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(NodeServices.layer));
    const checkpointDependenciesLayer = Layer.mergeAll(
      checkpointStoreLayer,
      CheckpointRepositoryLive,
      adapterRegistryLayer,
      ProviderSessionDirectoryLive,
    );
    const checkpointServiceLayer = CheckpointServiceLive.pipe(
      Layer.provideMerge(checkpointDependenciesLayer),
    );
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogPath: path.join(providerLogsDir, "provider-canonical.ndjson"),
    }).pipe(Layer.provideMerge(checkpointServiceLayer));

    const layer = Layer.mergeAll(orchestrationLayer, ProjectRepositoryLive, providerLayer).pipe(
      Layer.provide(persistenceLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);

    try {
      const [nextOrchestrationEngine, repository, nextProviderService] = await Promise.all([
        runtime.runPromise(Effect.service(OrchestrationEngineService)),
        runtime.runPromise(Effect.service(ProjectRepository)),
        runtime.runPromise(Effect.service(ProviderService)),
      ]);
      orchestrationEngine = nextOrchestrationEngine;
      projectRepository = repository;
      providerService = nextProviderService;
      await runtime.runPromise(repository.pruneMissing());
      await attachOrchestrationSubscriptions(runtime, nextOrchestrationEngine);
      await attachProviderSubscriptions(runtime, nextProviderService, nextOrchestrationEngine);
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }

    return runtime;
  }

  async function disposeEffectRuntime() {
    unsubscribeDomainEvents();
    unsubscribeProviderEvents();
    unsubscribeDomainEvents = noop;
    unsubscribeProviderEvents = noop;
    orchestrationDomainEventLogger?.close();
    orchestrationDomainEventLogger = undefined;
    orchestrationCommandLogger?.close();
    orchestrationCommandLogger = undefined;

    const runtime = effectRuntime;
    const liveProviderService = providerService;
    effectRuntime = null;
    orchestrationEngine = null;
    projectRepository = null;
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
