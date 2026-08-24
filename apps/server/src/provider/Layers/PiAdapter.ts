// @effect-diagnostics globalDate:off
import {
  IsoDateTime,
  type PiAgentSettings,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  T3_MCP_BEARER_TOKEN_ENV,
  T3_MCP_ENDPOINT_ENV,
} from "../../bundled-pi-extension/contract.ts";
import {
  resolveBundledMidsceneSkillPath,
  resolveBundledPiMcpExtensionPath,
} from "../../bundledSkills.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { spawnPiRpcClient, type PiRpcClient, type PiRpcClientError } from "../pi/PiRpcClient.ts";
import {
  isPiTurnSettledEvent,
  makePiRuntimeEventMapper,
  type PiRuntimeEventMapper,
} from "../pi/PiRuntimeEvents.ts";
import type { PiRpcOutput, PiRpcResponse } from "../pi/PiRpcProtocol.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");

export interface PiClientFactoryInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args?: ReadonlyArray<string>;
}

export type PiClientFactory = (
  input: PiClientFactoryInput,
) => Effect.Effect<
  PiRpcClient,
  PiRpcClientError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
>;

export interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createClient?: PiClientFactory;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly now?: () => string;
  readonly nextTurnId?: () => string;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly client: PiRpcClient;
  readonly mapper: PiRuntimeEventMapper;
  readonly sessionId: string;
  readonly sessionFile?: string;
  activeTurnId: TurnId | undefined;
  readonly pendingInputMethods: Map<string, string>;
  processFailed: boolean;
  stopped: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readState(response: PiRpcResponse) {
  if (!response.success) throw new Error(response.error);
  const data = asRecord(response.data);
  if (!data) throw new Error("Pi get_state response did not include state data.");
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
  if (!sessionId) {
    throw new Error("Pi get_state response did not include sessionId.");
  }
  const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
  const model = asRecord(data.model);
  const modelProvider = typeof model?.provider === "string" ? model.provider : undefined;
  const modelId = typeof model?.id === "string" ? model.id : undefined;
  return {
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(modelProvider && modelId ? { model: `${modelProvider}/${modelId}` } : {}),
  };
}

function readResumeSessionFile(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.sessionFile === "string" && record.sessionFile.trim().length > 0
    ? record.sessionFile.trim()
    : undefined;
}

function readMessageTurns(response: PiRpcResponse, sessionId: string) {
  if (!response.success) return [];
  const data = asRecord(response.data);
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return messages.flatMap((value, index) => {
    const message = asRecord(value);
    if (message?.role !== "assistant") return [];
    const messageId =
      (typeof message.id === "string" && message.id.trim()) ||
      (typeof message.entryId === "string" && message.entryId.trim()) ||
      `${sessionId}-history-${index}`;
    return [{ id: TurnId.make(messageId), items: [value] }];
  });
}

function readContextMessages(response: PiRpcResponse, sessionId: string) {
  const data = asRecord(response.success ? response.data : undefined);
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return messages.flatMap((value, index) => {
    const message = asRecord(value);
    if (!message) return [];
    const messageId =
      (typeof message.id === "string" && message.id.trim()) ||
      (typeof message.entryId === "string" && message.entryId.trim()) ||
      `${sessionId}-message-${index}`;
    const role =
      typeof message.role === "string" && message.role.trim().length > 0 ? message.role : null;
    const timestamp = message.timestamp;
    const createdAt =
      typeof timestamp === "string" && timestamp.trim().length > 0
        ? timestamp
        : typeof timestamp === "number" && Number.isFinite(timestamp)
          ? new Date(timestamp).toISOString()
          : null;
    return [{ id: messageId, role, createdAt, content: value }];
  });
}

function splitPiModel(value: string): { provider: string; modelId: string } | null {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function clientFailure(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : `Pi RPC ${method} failed.`,
    cause,
  });
}

function failedTurnMessage(events: ReadonlyArray<ProviderRuntimeEvent>): string | undefined {
  const completed = events.find(
    (event) => event.type === "turn.completed" && event.payload.state === "failed",
  );
  return completed?.type === "turn.completed"
    ? (completed.payload.errorMessage ?? "Pi turn failed.")
    : undefined;
}

const defaultCreateClient: PiClientFactory = (input) =>
  spawnPiRpcClient({
    binaryPath: input.binaryPath,
    cwd: input.cwd,
    ...(input.env ? { env: input.env } : {}),
    ...(input.args ? { args: input.args } : {}),
  });

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiAgentSettings,
  options: PiAdapterOptions = {},
) {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const bundledPiMcpExtensionPath = yield* resolveBundledPiMcpExtensionPath();
  const bundledMidsceneSkillPath = yield* resolveBundledMidsceneSkillPath();
  const instanceId = options.instanceId ?? ProviderInstanceId.make("piAgent");
  const createClient = options.createClient ?? defaultCreateClient;
  const now = options.now ?? (() => new Date().toISOString());
  let turnSequence = 0;
  const nextTurnId = options.nextTurnId ?? (() => `pi-turn-${++turnSequence}`);
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();

  const emit = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    events.length === 0 ? Effect.void : Queue.offerAll(runtimeEvents, events).pipe(Effect.asVoid);

  const logNative = (threadId: ThreadId, raw: PiRpcOutput) =>
    Effect.gen(function* () {
      if (!options.nativeEventLogger) return;
      const observedAt = now();
      yield* options.nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* crypto.randomUUIDv4,
            kind: "notification",
            provider: PROVIDER,
            providerInstanceId: instanceId,
            createdAt: observedAt,
            method: raw.type,
            threadId,
            payload: raw,
          },
        },
        threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to write native Pi RPC event log.", {
          cause,
          threadId,
          method: raw.type,
        }),
      ),
    );

  const updateSession = (
    context: PiSessionContext,
    patch: Partial<ProviderSession>,
    clearActiveTurn = false,
    clearLastError = false,
  ) => {
    const updated = { ...context.session, ...patch, updatedAt: IsoDateTime.make(now()) } as
      | ProviderSession
      | (ProviderSession & { activeTurnId?: never });
    if (clearActiveTurn) delete (updated as { activeTurnId?: TurnId }).activeTurnId;
    if (clearLastError) delete (updated as { lastError?: string }).lastError;
    context.session = updated;
  };

  const getContext = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const stopContext = Effect.fn("PiAdapter.stopContext")(function* (context: PiSessionContext) {
    if (context.stopped) return;
    context.stopped = true;
    sessions.delete(context.session.threadId);
    yield* context.client.close;
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    updateSession(context, { status: "closed" }, true);
  });

  const buildImages = Effect.fn("PiAdapter.buildImages")(function* (input: ProviderSendTurnInput) {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") continue;
      const path = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!path) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(path).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Failed to read attachment '${attachment.name}'.`,
              cause,
            }),
        ),
      );
      images.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      });
    }
    return images;
  });

  const startSession: PiAdapterShape["startSession"] = Effect.fn("PiAdapter.startSession")(
    function* (input) {
      if (input.provider && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected piAgent provider, received '${input.provider}'.`,
        });
      }
      if (sessions.has(input.threadId)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Thread '${input.threadId}' already has an active Pi session.`,
        });
      }
      const cwd = input.cwd ?? serverConfig.cwd;
      const resumeSessionFile = readResumeSessionFile(input.resumeCursor);
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const piArgs: string[] = [];
      if (mcpSession) {
        for (const [artifact, artifactPath] of [
          ["Pi MCP extension", bundledPiMcpExtensionPath],
          ["Midscene Skill", bundledMidsceneSkillPath],
        ] as const) {
          const exists = yield* fileSystem.exists(artifactPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "spawn",
                  detail: `Failed to inspect bundled ${artifact} at '${artifactPath}'.`,
                  cause,
                }),
            ),
          );
          if (!exists) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "spawn",
              detail: `Bundled ${artifact} is missing at '${artifactPath}'.`,
            });
          }
        }
        piArgs.push("--extension", bundledPiMcpExtensionPath, "--skill", bundledMidsceneSkillPath);
      }
      if (resumeSessionFile) piArgs.push("--session", resumeSessionFile);
      const environment = {
        ...options.environment,
        ...(settings.homePath ? { PI_CODING_AGENT_DIR: settings.homePath } : {}),
        ...(mcpSession
          ? {
              [T3_MCP_ENDPOINT_ENV]: mcpSession.endpoint,
              [T3_MCP_BEARER_TOKEN_ENV]: mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
            }
          : {}),
      };
      const sessionScope = yield* Scope.make();
      const client = yield* createClient({
        binaryPath: settings.binaryPath,
        cwd,
        ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
        ...(piArgs.length > 0 ? { args: piArgs } : {}),
      }).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        Effect.mapError((cause) => clientFailure("spawn", cause)),
      );
      const state = yield* client.request({ type: "get_state" }).pipe(
        Effect.mapError((cause) => clientFailure("get_state", cause)),
        Effect.flatMap((response) =>
          Effect.try({
            try: () => readState(response),
            catch: (cause) => clientFailure("get_state", cause),
          }),
        ),
      );
      const timestamp = IsoDateTime.make(now());
      const resumeCursor = {
        sessionId: state.sessionId,
        ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
      };
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(state.model ? { model: state.model } : {}),
        threadId: input.threadId,
        resumeCursor,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const mapper = makePiRuntimeEventMapper({
        providerInstanceId: instanceId,
        threadId: input.threadId,
        now,
        nextId: (prefix) => `${input.threadId}-${prefix}-${++turnSequence}`,
      });
      const context: PiSessionContext = {
        session,
        scope: sessionScope,
        client,
        mapper,
        sessionId: state.sessionId,
        ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
        activeTurnId: undefined,
        pendingInputMethods: new Map(),
        processFailed: false,
        stopped: false,
      };
      sessions.set(input.threadId, context);
      yield* emit(mapper.startSession(resumeCursor));

      const handleNativeEvent = Effect.fn("PiAdapter.handleNativeEvent")(function* (
        raw: PiRpcOutput,
      ) {
        if (context.processFailed) return;
        yield* logNative(input.threadId, raw);
        if (raw.type === "extension_ui_request") {
          const record = raw as Record<string, unknown>;
          if (typeof record.id === "string" && typeof record.method === "string") {
            context.pendingInputMethods.set(record.id, record.method);
          }
        }
        const mappedEvents = mapper.map(raw);
        yield* emit(mappedEvents);
        if (!isPiTurnSettledEvent(raw)) return;
        context.activeTurnId = undefined;
        const turnFailure = failedTurnMessage(mappedEvents);
        updateSession(
          context,
          turnFailure ? { status: "error", lastError: turnFailure } : { status: "ready" },
          true,
          turnFailure === undefined,
        );
        const stats = yield* client.request({ type: "get_session_stats" }).pipe(Effect.option);
        if (stats._tag === "Some" && stats.value.success) {
          yield* emit(mapper.updateTokenUsage((asRecord(stats.value.data) ?? {}) as never));
        }
      });
      yield* Stream.runForEach(client.events, handleNativeEvent).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(sessionScope, { startImmediately: true }),
      );
      yield* client.terminated.pipe(
        Effect.flatMap((error) =>
          context.stopped
            ? Effect.void
            : Effect.gen(function* () {
                context.processFailed = true;
                context.activeTurnId = undefined;
                updateSession(context, { status: "error", lastError: error.detail }, true);
                yield* emit(mapper.failRuntime(error.detail));
              }),
        ),
        Effect.forkIn(sessionScope, { startImmediately: true }),
      );
      return session;
    },
  );

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("PiAdapter.sendTurn")(function* (input) {
    const context = yield* getContext(input.threadId);
    if (context.activeTurnId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Thread '${input.threadId}' already has an active turn.`,
      });
    }
    const turnId = TurnId.make(nextTurnId());
    const modelSelection =
      input.modelSelection?.instanceId === instanceId ? input.modelSelection : undefined;
    const selectedModel = modelSelection?.model;
    if (selectedModel && selectedModel !== context.session.model) {
      const parsed = splitPiModel(selectedModel);
      if (!parsed) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Pi model '${selectedModel}' must use provider/model format.`,
        });
      }
      yield* context.client
        .request({ type: "set_model", ...parsed })
        .pipe(Effect.mapError((cause) => clientFailure("set_model", cause)));
    }
    const effort = getModelSelectionStringOptionValue(modelSelection, "effort");
    if (effort) {
      yield* context.client
        .request({ type: "set_thinking_level", level: effort })
        .pipe(Effect.mapError((cause) => clientFailure("set_thinking_level", cause)));
    }
    const images = yield* buildImages(input);
    context.activeTurnId = turnId;
    updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(selectedModel ? { model: selectedModel } : {}),
    });
    yield* emit(
      context.mapper.startTurn({
        turnId,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(effort ? { effort } : {}),
      }),
    );
    yield* context.client
      .request({
        type: "prompt",
        message: input.input ?? "",
        ...(images.length > 0 ? { images } : {}),
      })
      .pipe(Effect.mapError((cause) => clientFailure("prompt", cause)));
    return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("PiAdapter.interruptTurn")(
    function* (threadId, turnId) {
      const context = yield* getContext(threadId);
      if (!context.activeTurnId || (turnId && turnId !== context.activeTurnId)) return;
      yield* context.client
        .send({ type: "abort" })
        .pipe(Effect.mapError((cause) => clientFailure("abort", cause)));
      yield* emit(context.mapper.completeTurn("interrupted"));
      context.activeTurnId = undefined;
      updateSession(context, { status: "ready" }, true);
    },
  );

  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToRequest",
        issue: `Pi session '${threadId}' does not expose built-in tool approvals.`,
      }),
    );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn(
    "PiAdapter.respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* getContext(threadId);
    const method = context.pendingInputMethods.get(requestId);
    if (!method) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue: `Unknown Pi extension input request '${requestId}'.`,
      });
    }
    const answer = answers.value;
    yield* context.client
      .send(
        method === "confirm"
          ? {
              type: "extension_ui_response",
              id: requestId,
              confirmed: answer === true || String(answer).toLowerCase() === "yes",
            }
          : answer === undefined
            ? { type: "extension_ui_response", id: requestId, cancelled: true }
            : { type: "extension_ui_response", id: requestId, value: String(answer) },
      )
      .pipe(Effect.mapError((cause) => clientFailure("extension_ui_response", cause)));
    context.pendingInputMethods.delete(requestId);
    yield* emit(context.mapper.resolveUserInput(requestId, answer));
  });

  const readThread: PiAdapterShape["readThread"] = Effect.fn("PiAdapter.readThread")(
    function* (threadId) {
      const context = yield* getContext(threadId);
      const response = yield* context.client
        .request({ type: "get_messages" })
        .pipe(Effect.mapError((cause) => clientFailure("get_messages", cause)));
      return { threadId, turns: readMessageTurns(response, context.sessionId) };
    },
  );

  const readThreadContext: PiAdapterShape["readThreadContext"] = Effect.fn(
    "PiAdapter.readThreadContext",
  )(function* (threadId) {
    const context = yield* getContext(threadId);
    const response = yield* context.client
      .request({ type: "get_messages" })
      .pipe(Effect.mapError((cause) => clientFailure("get_messages", cause)));
    return {
      threadId,
      provider: PROVIDER,
      messages: readContextMessages(response, context.sessionId),
    };
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: `Pi thread '${threadId}' does not support T3 rollback.`,
      }),
    );

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("PiAdapter.stopSession")(
    function* (threadId) {
      const context = yield* getContext(threadId);
      yield* stopContext(context);
    },
  );

  const stopAll = Effect.fn("PiAdapter.stopAll")(function* () {
    yield* Effect.forEach([...sessions.values()], stopContext, {
      concurrency: "unbounded",
      discard: true,
    });
  });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread,
    readThreadContext,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEvents),
  } satisfies PiAdapterShape;
});
