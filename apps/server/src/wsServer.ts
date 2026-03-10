/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import { spawn } from "node:child_process";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ClientOrchestrationCommand,
  type OrchestrationCreateBranchedThreadInput,
  type OrchestrationCommand,
  MessageId,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  WsResponse,
  ServerProviderStatus,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
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
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory.ts";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { getServerVersion } from "./version";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

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

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

type WebSocketRequestBody = WebSocketRequest["body"];

function castRequestBody<Tag extends WebSocketRequestBody["_tag"]>(
  body: WebSocketRequestBody,
  _tag: Tag,
): Extract<WebSocketRequestBody, { _tag: Tag }> {
  return body as Extract<WebSocketRequestBody, { _tag: Tag }>;
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  const message =
    squashed instanceof Error ? squashed.message.trim() : String(squashed).trim();
  return message.length > 0 ? message : Cause.pretty(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderSessionDirectory
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService;

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
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    defaultProjectsPath,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

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

  const encodePush = Schema.encodeEffect(Schema.fromJsonString(WsPush));
  const broadcastPush = Effect.fnUntraced(function* (push: WsPush) {
    const message = yield* encodePush(push);
    let recipients = 0;
    for (const client of yield* Ref.get(clients)) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    yield* broadcastPush({
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    });
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (
      input.command.type === "project.meta.update" &&
      input.command.workspaceRoot !== undefined
    ) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  const createBranchedThread = Effect.fnUntraced(function* (
    input: OrchestrationCreateBranchedThreadInput,
  ) {
    const sourceBindingOption = yield* providerSessionDirectory.getBinding(input.sourceThreadId);
    const sourceBinding = Option.getOrUndefined(sourceBindingOption);
    if (!sourceBinding) {
      return yield* new RouteRequestError({
        message: `Cannot branch thread '${input.sourceThreadId}' because no provider session binding was found.`,
      });
    }

    const snapshot = yield* projectionReadModelQuery.getSnapshot();
    const sourceThread = snapshot.threads.find((thread) => thread.id === input.sourceThreadId);
    if (!sourceThread || sourceThread.deletedAt !== null) {
      return yield* new RouteRequestError({
        message: `Source thread '${input.sourceThreadId}' was not found.`,
      });
    }
    if (sourceThread.projectId !== input.projectId) {
      return yield* new RouteRequestError({
        message: "Branched threads must stay within the same project.",
      });
    }
    if (snapshot.threads.some((thread) => thread.id === input.newThreadId)) {
      return yield* new RouteRequestError({
        message: `Thread '${input.newThreadId}' already exists.`,
      });
    }

    const sourceMessage = sourceThread.messages.find((message) => message.id === input.sourceMessageId);
    if (!sourceMessage) {
      return yield* new RouteRequestError({
        message: `Message '${input.sourceMessageId}' was not found in thread '${input.sourceThreadId}'.`,
      });
    }

    const sourceUserMessage =
      input.kind === "edit"
        ? sourceMessage.role === "user"
          ? sourceMessage
          : null
        : sourceMessage.role === "assistant" && sourceMessage.turnId !== null
          ? sourceThread.messages.find(
              (message) => message.role === "user" && message.turnId === sourceMessage.turnId,
            ) ?? null
          : null;
    if (!sourceUserMessage) {
      return yield* new RouteRequestError({
        message:
          input.kind === "edit"
            ? "Edit branching requires a user message."
            : "Retry branching requires an assistant message with a matching user turn.",
      });
    }

    const targetCheckpoint =
      input.kind === "edit"
        ? (() => {
            const sourceMessageIndex = sourceThread.messages.findIndex(
              (message) => message.id === sourceMessage.id,
            );
            if (sourceMessageIndex < 0) {
              return null;
            }
            for (let index = sourceMessageIndex + 1; index < sourceThread.messages.length; index += 1) {
              const nextMessage = sourceThread.messages[index];
              if (!nextMessage) {
                continue;
              }
              if (nextMessage.role === "user") {
                break;
              }
              if (nextMessage.role !== "assistant" || nextMessage.turnId === null) {
                continue;
              }
              const checkpoint = sourceThread.checkpoints.find(
                (entry) => entry.turnId === nextMessage.turnId,
              );
              if (checkpoint) {
                return checkpoint;
              }
            }
            return null;
          })()
        : sourceMessage.turnId !== null
          ? sourceThread.checkpoints.find((checkpoint) => checkpoint.turnId === sourceMessage.turnId) ?? null
          : null;
    if (!targetCheckpoint) {
      return yield* new RouteRequestError({
        message:
          input.kind === "edit"
            ? "The selected message does not have a completed response to branch from yet."
            : "The selected message does not have a checkpoint to branch from yet.",
      });
    }

    const latestCheckpointTurnCount = sourceThread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const turnsToRollback = Math.max(
      0,
      latestCheckpointTurnCount - targetCheckpoint.checkpointTurnCount + 1,
    );
    const nextMessageText =
      input.kind === "edit" ? (input.messageText ?? sourceUserMessage.text) : sourceUserMessage.text;
    if (nextMessageText.length === 0 && (sourceUserMessage.attachments?.length ?? 0) === 0) {
      return yield* new RouteRequestError({
        message: "Branched turns require message text or at least one attachment.",
      });
    }

    let createdThread = false;
    let persistedBinding = false;

    return yield* Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: input.newThreadId,
        projectId: input.projectId,
        title: input.title,
        model: input.model,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: input.createdAt,
      });
      createdThread = true;

      yield* providerSessionDirectory.upsert({
        threadId: input.newThreadId,
        provider: sourceBinding.provider,
        ...(sourceBinding.adapterKey !== undefined ? { adapterKey: sourceBinding.adapterKey } : {}),
        runtimeMode: input.runtimeMode,
        ...(sourceBinding.status !== undefined ? { status: sourceBinding.status } : {}),
        ...(sourceBinding.resumeCursor !== undefined
          ? { resumeCursor: sourceBinding.resumeCursor }
          : {}),
        runtimePayload: isRecord(sourceBinding.runtimePayload)
          ? {
              ...sourceBinding.runtimePayload,
              activeTurnId: null,
              lastRuntimeEvent: "orchestration.createBranchedThread",
              lastRuntimeEventAt: input.createdAt,
            }
          : sourceBinding.runtimePayload ?? null,
      });
      persistedBinding = true;

      if (turnsToRollback > 0) {
        yield* providerService.rollbackConversation({
          threadId: input.newThreadId,
          numTurns: turnsToRollback,
        });
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: input.newThreadId,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: nextMessageText,
          attachments: sourceUserMessage.attachments ?? [],
        },
        provider: input.provider ?? sourceBinding.provider,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(input.assistantDeliveryMode
          ? { assistantDeliveryMode: input.assistantDeliveryMode }
          : {}),
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      });

      return { threadId: input.newThreadId };
    }).pipe(
      Effect.tapError(() =>
        Effect.all([
          persistedBinding
            ? providerSessionDirectory.remove(input.newThreadId).pipe(Effect.catch(() => Effect.void))
            : Effect.void,
          createdThread
            ? orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                  threadId: input.newThreadId,
                })
                .pipe(Effect.catch(() => Effect.void))
            : Effect.void,
        ]).pipe(Effect.asVoid),
      ),
    );
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (streamExit._tag === "Failure") {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        if (url.pathname === "/api/dev-restart") {
          const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          };
          if (req.method === "OPTIONS") {
            respond(204, corsHeaders);
            return;
          }
          if (req.method !== "POST") {
            respond(405, { ...corsHeaders, "Content-Type": "text/plain" }, "Method Not Allowed");
            return;
          }
          if (!devUrl) {
            respond(403, { ...corsHeaders, "Content-Type": "text/plain" }, "Dev restart unavailable");
            return;
          }

          respond(
            202,
            { ...corsHeaders, "Content-Type": "application/json" },
            JSON.stringify({ ok: true }),
          );

          setTimeout(() => {
            try {
              const serverRoot = nodePath.resolve(
                nodePath.dirname(fileURLToPath(import.meta.url)),
                "..",
              );
              const child = spawn("bun", ["run", "dev"], {
                cwd: serverRoot,
                env: process.env,
                detached: true,
                stdio: "ignore",
              });
              child.unref();
            } catch {
              // Swallow spawn errors so we still exit.
            }
            setTimeout(() => {
              process.exit(0);
            }, 150);
          }, 50);
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
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
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  // Push updated provider statuses to connected clients once background health checks finish.
  let providers: ReadonlyArray<ServerProviderStatus> = [];
  yield* providerHealth.getStatuses.pipe(
    Effect.flatMap((statuses) => {
      providers = statuses;
      return broadcastPush({
        type: "push",
        channel: WS_CHANNELS.serverConfigUpdated,
        data: {
          issues: [],
          providers: statuses,
        },
      });
    }),
    Effect.forkIn(subscriptionsScope),
  );

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    broadcastPush({
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: event,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.changes, (event) =>
    broadcastPush({
      type: "push",
      channel: WS_CHANNELS.serverConfigUpdated,
      data: {
        issues: event.issues,
        providers,
      },
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

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

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    const requestTag = String(request.body._tag);

    switch (requestTag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = castRequestBody(request.body, ORCHESTRATION_WS_METHODS.dispatchCommand);
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.createBranchedThread: {
        const body = stripRequestTag(
          castRequestBody(request.body, ORCHESTRATION_WS_METHODS.createBranchedThread),
        );
        return yield* createBranchedThread(body);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(
          castRequestBody(request.body, ORCHESTRATION_WS_METHODS.getTurnDiff),
        );
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(
          castRequestBody(request.body, ORCHESTRATION_WS_METHODS.getFullThreadDiff),
        );
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = castRequestBody(
          request.body,
          ORCHESTRATION_WS_METHODS.replayEvents,
        );
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
        const body = stripRequestTag(
          castRequestBody(request.body, WS_METHODS.projectsSearchEntries),
        );
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsCreateWorkspace: {
        const body = stripRequestTag(
          castRequestBody(request.body, WS_METHODS.projectsCreateWorkspace),
        );
        const workspaceName = body.name.trim();
        if (
          workspaceName.length === 0 ||
          workspaceName === "." ||
          workspaceName === ".." ||
          workspaceName.includes("/") ||
          workspaceName.includes("\\")
        ) {
          return yield* new RouteRequestError({
            message: "Project name must be a single folder name.",
          });
        }

        const normalizedProjectsRoot = path.resolve(defaultProjectsPath);
        const targetCwd = path.resolve(normalizedProjectsRoot, workspaceName);
        const relativeTargetPath = path.relative(normalizedProjectsRoot, targetCwd);
        if (
          relativeTargetPath.length === 0 ||
          relativeTargetPath === "." ||
          relativeTargetPath.startsWith("..") ||
          path.isAbsolute(relativeTargetPath)
        ) {
          return yield* new RouteRequestError({
            message: "Project name must stay within the default Projects directory.",
          });
        }

        yield* fileSystem.makeDirectory(normalizedProjectsRoot, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to prepare the default Projects directory: ${String(cause)}`,
              }),
          ),
        );

        const existingTarget = yield* fileSystem.stat(targetCwd).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (existingTarget && existingTarget.type !== "Directory") {
          return yield* new RouteRequestError({
            message: `Project path is not a directory: ${targetCwd}`,
          });
        }

        yield* fileSystem.makeDirectory(targetCwd, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to create project directory: ${String(cause)}`,
              }),
          ),
        );

        return { cwd: targetCwd };
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.projectsWriteFile));
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to prepare workspace path: ${String(cause)}`,
              }),
          ),
        );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.shellOpenInEditor));
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitStatus));
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitPull));
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitRunStackedAction));
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitListBranches));
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitCreateWorktree));
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitRemoveWorktree));
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitCreateBranch));
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitCheckout));
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.gitInit));
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.terminalOpen));
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.terminalWrite));
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.terminalResize));
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.terminalClear));
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.terminalRestart));
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.terminalClose));
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        return {
          cwd,
          defaultProjectsPath,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors,
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(castRequestBody(request.body, WS_METHODS.serverUpsertKeybinding));
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      default: {
        return yield* new RouteRequestError({
          message: `Unknown method: ${requestTag}`,
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
        error: { message: `Invalid request format: ${messageFromCause(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: messageFromCause(result.cause) },
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
    void runPromise(Ref.update(clients, (clients) => clients.add(ws)));

    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";
    const serverVersion = getServerVersion();

    const welcome: WsPush = {
      type: "push",
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd,
        projectName,
        serverVersion,
        ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
        ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
      },
    };
    logOutgoingPush(welcome, 1);
    ws.send(JSON.stringify(welcome));

    ws.on("message", (raw) => {
      void runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) => Effect.logError("Error handling message", error)),
        ),
      );
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
