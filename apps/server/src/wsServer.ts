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
  type OrchestrationReadModelPush,
  type TerminalEvent,
  type WsPush,
  type WsRequest,
  type WsResponse,
  wsRequestSchema,
} from "@t3tools/contracts";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { ProjectRegistry } from "./projectRegistry";
import { ProviderManager } from "./providerManager";
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
import { createOrchestrationEngine } from "./orchestration/runtime";

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
  staticDir?: string | undefined;
  devUrl?: string | undefined;
  logWebSocketEvents?: boolean | undefined;
  projectRegistry?: ProjectRegistry | undefined;
  gitManager?: GitManager | undefined;
  terminalManager?: TerminalManager | undefined;
  authToken?: string | undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createServer(options: ServerOptions) {
  const {
    port,
    host,
    cwd,
    stateDir,
    staticDir,
    devUrl,
    logWebSocketEvents: explicitLogWsEvents,
    projectRegistry: providedRegistry,
    gitManager: providedGitManager,
    terminalManager: providedTerminalManager,
    authToken,
  } = options;
  const providerManager = new ProviderManager();
  const terminalManager = providedTerminalManager ?? new TerminalManager();
  const projectRegistry =
    providedRegistry ?? new ProjectRegistry(path.join(os.homedir(), ".t3", "userdata"));
  const gitManager = providedGitManager ?? new GitManager();
  const orchestrationEngine = createOrchestrationEngine(
    stateDir ?? path.join(os.homedir(), ".t3", "userdata"),
  );
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

  const unsubscribeReadModel = orchestrationEngine.subscribeToReadModel((snapshot) => {
    const push: WsPush = {
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.readModel,
      data: {
        sequence: snapshot.sequence,
        snapshot,
      } satisfies OrchestrationReadModelPush,
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
  });

  const unsubscribeDomainEvents = orchestrationEngine.subscribeToDomainEvents((event) => {
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
  });

  // Forward provider events to all connected WebSocket clients
  providerManager.on("event", (event) => {
    void (async () => {
      const snapshot = orchestrationEngine.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.session?.sessionId === event.sessionId);
      if (!thread) return;
      const now = event.createdAt;
      if (event.method === "turn/started" || event.method === "turn/completed") {
        await orchestrationEngine.dispatch({
          type: "thread.session",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          session: {
            sessionId: event.sessionId,
            provider: event.provider,
            status: event.method === "turn/started" ? "running" : "ready",
            threadId: thread.id,
            activeTurnId: event.method === "turn/started" ? (event.turnId ?? null) : null,
            createdAt: thread.session?.createdAt ?? now,
            updatedAt: now,
            lastError: null,
          },
          createdAt: now,
        });
      }
      if (event.textDelta && event.textDelta.length > 0) {
        const assistantMessageId = `assistant:${event.turnId ?? event.itemId ?? event.sessionId}`;
        await orchestrationEngine.dispatch({
          type: "message.send",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
          messageId: assistantMessageId,
          role: "assistant",
          text: event.textDelta,
          streaming: true,
          createdAt: now,
        });
      }
      if (event.method === "turn/completed") {
        const assistantMessageId = `assistant:${event.turnId ?? event.itemId ?? event.sessionId}`;
        await orchestrationEngine.dispatch({
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
      if (event.method === "checkpoint/captured") {
        const payload = asObject(event.payload);
        const turnId = event.turnId ?? asString(payload?.turnId);
        if (turnId) {
          await orchestrationEngine.dispatch({
            type: "thread.turnDiff.complete",
            commandId: crypto.randomUUID(),
            threadId: thread.id,
            turnId,
            completedAt: now,
            ...(asString(payload?.status) !== null ? { status: asString(payload?.status) ?? undefined } : {}),
            files: [],
            assistantMessageId: `assistant:${turnId}`,
            ...(asNumber(payload?.turnCount) !== null
              ? { checkpointTurnCount: asNumber(payload?.turnCount) ?? undefined }
              : {}),
            createdAt: now,
          });
        }
      }
      if (event.kind === "error" && event.message) {
        await orchestrationEngine.dispatch({
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
    })().catch(() => undefined);
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

    const snapshotPush: WsPush = {
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.readModel,
      data: {
        sequence: orchestrationEngine.getSnapshot().sequence,
        snapshot: orchestrationEngine.getSnapshot(),
      } satisfies OrchestrationReadModelPush,
    };
    logOutgoingPush(snapshotPush, 1);
    ws.send(JSON.stringify(snapshotPush));

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
    switch (request.method) {
      case WS_METHODS.providersStartSession:
        return providerManager.startSession(request.params as never);

      case WS_METHODS.providersSendTurn:
        return providerManager.sendTurn(request.params as never);

      case WS_METHODS.providersInterruptTurn:
        return providerManager.interruptTurn(request.params as never);

      case WS_METHODS.providersRespondToRequest:
        return providerManager.respondToRequest(request.params as never);

      case WS_METHODS.providersStopSession: {
        providerManager.stopSession(request.params as never);
        return undefined;
      }

      case WS_METHODS.providersListCheckpoints:
        return providerManager.listCheckpoints(request.params as never);

      case WS_METHODS.providersGetCheckpointDiff:
        return providerManager.getCheckpointDiff(request.params as never);

      case WS_METHODS.providersRevertToCheckpoint:
        {
          const result = await providerManager.revertToCheckpoint(request.params as never);
          const params = request.params as { sessionId?: string };
          const sessionId = params.sessionId;
          if (typeof sessionId === "string") {
            const snapshot = orchestrationEngine.getSnapshot();
            const thread = snapshot.threads.find((entry) => entry.session?.sessionId === sessionId);
            if (thread) {
              const now = new Date().toISOString();
              await orchestrationEngine.dispatch({
                type: "thread.revert",
                commandId: crypto.randomUUID(),
                threadId: thread.id,
                turnCount: result.turnCount,
                messageCount: result.messageCount,
                createdAt: now,
              });
              if (thread.session) {
                await orchestrationEngine.dispatch({
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
                });
              }
            }
          }
          return result;
        }

      case WS_METHODS.projectsList:
        return projectRegistry.list();

      case WS_METHODS.projectsAdd:
        {
          const result = await projectRegistry.add(request.params as never);
          await orchestrationEngine.dispatch({
            type: "project.create",
            commandId: crypto.randomUUID(),
            projectId: result.project.id,
            name: result.project.name,
            cwd: result.project.cwd,
            model: "gpt-5-codex",
            createdAt: new Date().toISOString(),
          });
          return result;
        }

      case WS_METHODS.projectsRemove:
        {
          const params = request.params as { id: string };
          projectRegistry.remove(request.params as never);
          await orchestrationEngine.dispatch({
            type: "project.delete",
            commandId: crypto.randomUUID(),
            projectId: params.id,
            createdAt: new Date().toISOString(),
          });
          return undefined;
        }

      case WS_METHODS.projectsSearchEntries:
        return searchWorkspaceEntries(request.params as never);
      case WS_METHODS.projectsUpdateScripts:
        return projectRegistry.updateScripts(request.params as never);

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

      case WS_METHODS.gitStatus:
        {
          const params = request.params as { cwd: string };
          const status = await gitManager.status(request.params as never);
          const project = projectRegistry.list().find((entry) => entry.cwd === params.cwd);
          if (project) {
            await orchestrationEngine.dispatch({
              type: "git.readModel.upsert",
              commandId: crypto.randomUUID(),
              projectId: project.id,
              branch: status.branch,
              hasWorkingTreeChanges: status.hasWorkingTreeChanges,
              aheadCount: status.aheadCount,
              behindCount: status.behindCount,
              createdAt: new Date().toISOString(),
            });
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
        return orchestrationEngine.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand:
        return orchestrationEngine.dispatchUnknown(request.params);

      case ORCHESTRATION_WS_METHODS.replayEvents:
        return orchestrationEngine.replayEvents(
          Math.max(
            0,
            Math.floor(
              Number(
                (request.params as { fromSequenceExclusive?: number } | undefined)
                  ?.fromSequenceExclusive ?? 0,
              ),
            ),
          ),
        );

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  function start() {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        httpServer.off("error", onError);
        reject(error);
      };
      httpServer.once("error", onError);
      const onListening = async () => {
        httpServer.off("error", onError);
        try {
          await orchestrationEngine.start();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Failed to start orchestration engine"));
        }
      };
      if (host) {
        httpServer.listen(port, host, onListening);
        return;
      }
      httpServer.listen(port, onListening);
    });
  }

  async function stop(): Promise<void> {
    unsubscribeReadModel();
    unsubscribeDomainEvents();
    await orchestrationEngine.stop();
    terminalManager.off("event", onTerminalEvent);
    providerManager.stopAll();
    providerManager.dispose();
    terminalManager.dispose();

    for (const client of clients) {
      client.close();
    }
    clients.clear();

    const isServerNotRunningError = (error: unknown): boolean => {
      if (!(error instanceof Error)) return false;
      const maybeCode = (error as NodeJS.ErrnoException).code;
      return (
        maybeCode === "ERR_SERVER_NOT_RUNNING" ||
        error.message.toLowerCase().includes("not running")
      );
    };

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
