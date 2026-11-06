import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as VibeError from "./errors.ts";
import * as VibeProtocol from "./protocol.ts";

const ServerInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});
export const InitializeResult = Schema.Struct({
  serverInfo: ServerInfo,
  processId: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type InitializeResult = typeof InitializeResult.Type;

const TokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cachedTokens: Schema.optional(Schema.Number),
});

const PublicSessionWorktree = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  path: Schema.String,
});

export const PublicSession = Schema.Struct({
  id: Schema.String,
  rootSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  parentSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  preview: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Unknown),
  createdAt: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  workspaceRoots: Schema.optional(Schema.Array(Schema.String)),
  worktree: Schema.optional(Schema.NullOr(PublicSessionWorktree)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
  tokenUsage: Schema.optional(Schema.NullOr(TokenUsage)),
  contextUsage: Schema.optional(Schema.NullOr(TokenUsage)),
});
export type PublicSession = typeof PublicSession.Type;

export const PublicSessionState = Schema.Struct({
  format: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.Number),
  session: PublicSession,
  isQuiescent: Schema.optional(Schema.NullOr(Schema.Boolean)),
  turns: Schema.optional(Schema.Array(Schema.Unknown)),
  activeCallbacks: Schema.optional(Schema.Array(Schema.Unknown)),
  childSessions: Schema.optional(Schema.Array(Schema.Unknown)),
  backgroundProcesses: Schema.optional(Schema.Array(Schema.Unknown)),
  retrying: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
export type PublicSessionState = typeof PublicSessionState.Type;

const EventWatermark = Schema.Struct({
  lastEventId: Schema.optional(Schema.Number),
});

export const SessionStartResult = Schema.Struct({
  ...EventWatermark.fields,
  state: PublicSessionState,
});
export type SessionStartResult = typeof SessionStartResult.Type;

export const SessionResumeResult = Schema.Struct({
  ...EventWatermark.fields,
  state: PublicSessionState,
});
export type SessionResumeResult = typeof SessionResumeResult.Type;

export const PublicTurn = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  status: Schema.String,
  inputEntryId: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.Number),
  completedAt: Schema.optional(Schema.NullOr(Schema.Number)),
  error: Schema.optional(Schema.NullOr(Schema.Unknown)),
  stopReason: Schema.optional(Schema.NullOr(Schema.String)),
  queueItemId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PublicTurn = typeof PublicTurn.Type;

export const PageResult = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  previousCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const AccountBudgetView = Schema.Struct({
  usagePercentage: Schema.Number,
  resetAt: Schema.optional(Schema.NullOr(Schema.String)),
  paygEnabled: Schema.optional(Schema.Boolean),
});
export const AccountPlanView = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
});
export const AccountView = Schema.Struct({
  status: Schema.String,
  plan: Schema.optional(Schema.NullOr(AccountPlanView)),
  budget: Schema.optional(Schema.NullOr(AccountBudgetView)),
  apiKey: Schema.optional(
    Schema.NullOr(Schema.Struct({ preview: Schema.String, scope: Schema.String })),
  ),
  rateLimitAction: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
export type AccountView = typeof AccountView.Type;
export const AccountReadResult = Schema.Struct({ account: AccountView });

export const ConfigModelEntry = Schema.Struct({
  name: Schema.String,
  alias: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  thinkingLevels: Schema.optional(Schema.Array(Schema.String)),
  supportsImages: Schema.optional(Schema.Boolean),
  maxContextLength: Schema.optional(Schema.NullOr(Schema.Number)),
});
export const ConfigView = Schema.Struct({
  activeModel: Schema.optional(Schema.Unknown),
  defaultModelAlias: Schema.optional(Schema.String),
  defaultAgent: Schema.optional(Schema.String),
  models: Schema.optional(Schema.Array(ConfigModelEntry)),
  worktreeLimit: Schema.optional(Schema.Number),
});
export const ConfigReadResult = Schema.Struct({ config: ConfigView });
export type ConfigView = typeof ConfigView.Type;

export const GitCheckout = Schema.Struct({
  repoLocalPath: Schema.String,
  ok: Schema.Boolean,
  isPrimary: Schema.optional(Schema.Boolean),
  repoUrl: Schema.optional(Schema.NullOr(Schema.String)),
  root: Schema.optional(Schema.NullOr(Schema.String)),
  worktree: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  baseBranch: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.NullOr(Schema.String)),
});
export const GitCheckoutsResult = Schema.Struct({
  checkouts: Schema.optional(Schema.Array(GitCheckout)),
});
export type GitCheckout = typeof GitCheckout.Type;

export const TrustStatusResult = Schema.Struct({
  status: Schema.Literals(["trusted", "session", "untrusted"]),
  details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cwd: Schema.String,
        repoRoot: Schema.optional(Schema.NullOr(Schema.String)),
        availableDecisions: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
});
export type TrustStatusResult = typeof TrustStatusResult.Type;

export const EventsReadResult = Schema.Struct({
  type: Schema.optional(Schema.String),
  events: Schema.Array(Schema.Unknown),
});

export const TurnEnqueueResult = Schema.Struct({
  queueItemId: Schema.String,
  waits: Schema.optional(Schema.Boolean),
});

export interface VibeAppServerClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (
    event: VibeProtocol.VibeAppServerProtocolLogEvent,
  ) => Effect.Effect<void, never>;
}

type ServerRequestHandler = (
  method: string,
  params: unknown,
) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
type ServerNotificationHandler = (
  method: string,
  params: unknown,
) => Effect.Effect<void, VibeError.VibeAppServerError>;

export class VibeAppServerClient extends Context.Service<
  VibeAppServerClient,
  {
    readonly awaitTermination: Effect.Effect<never, VibeError.VibeAppServerError>;
    readonly request: (
      method: string,
      params?: unknown,
    ) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly notify: (
      method: string,
      params?: unknown,
    ) => Effect.Effect<void, VibeError.VibeAppServerError>;
    readonly handleServerRequest: (
      method: string,
      handler: ServerRequestHandler,
    ) => Effect.Effect<void>;
    readonly handleServerNotification: (
      method: string,
      handler: ServerNotificationHandler,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerRequest: (handler: ServerRequestHandler) => Effect.Effect<void>;
    readonly handleUnknownServerNotification: (
      handler: ServerNotificationHandler,
    ) => Effect.Effect<void>;

    // Typed methods (camelCase wire).
    readonly initialize: (input: {
      clientName: string;
      clientVersion: string;
      capabilities?: unknown;
    }) => Effect.Effect<InitializeResult, VibeError.VibeAppServerError>;
    readonly initialized: () => Effect.Effect<void, VibeError.VibeAppServerError>;
    readonly accountRead: (
      sessionId: string,
    ) => Effect.Effect<AccountView, VibeError.VibeAppServerError>;
    readonly configRead: (
      sessionId?: string,
    ) => Effect.Effect<ConfigView, VibeError.VibeAppServerError>;
    readonly configModelWrite: (input: {
      sessionId: string;
      modelAlias?: string | undefined;
      reasoningEffort?: string | undefined;
      sessionOnly?: boolean;
    }) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly sessionStart: (
      params: unknown,
    ) => Effect.Effect<SessionStartResult, VibeError.VibeAppServerError>;
    readonly sessionResume: (input: {
      sessionId: string;
      agentConfig?: unknown;
    }) => Effect.Effect<SessionResumeResult, VibeError.VibeAppServerError>;
    readonly sessionRead: (input: {
      sessionId: string;
      history?: unknown;
      turns?: unknown;
    }) => Effect.Effect<SessionStartResult, VibeError.VibeAppServerError>;
    readonly sessionList: (
      params?: unknown,
    ) => Effect.Effect<typeof PageResult.Type, VibeError.VibeAppServerError>;
    readonly sessionDelete: (
      sessionId: string,
    ) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly sessionStop: (input: {
      sessionId: string;
      reason?: string | undefined;
    }) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly sessionTurnEnqueue: (input: {
      sessionId: string;
      entries: ReadonlyArray<unknown>;
    }) => Effect.Effect<typeof TurnEnqueueResult.Type, VibeError.VibeAppServerError>;
    readonly turnSteer: (input: {
      sessionId: string;
      expectedTurnId: string;
      message: ReadonlyArray<unknown>;
    }) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly turnInterrupt: (input: {
      sessionId: string;
      expectedTurnId: string;
    }) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly sessionHistoryList: (input: {
      sessionId: string;
      cursor?: string | null | undefined;
      limit?: number;
    }) => Effect.Effect<typeof PageResult.Type, VibeError.VibeAppServerError>;
    readonly sessionTurnsList: (input: {
      sessionId: string;
      cursor?: string | null | undefined;
      limit?: number;
    }) => Effect.Effect<ReadonlyArray<PublicTurn>, VibeError.VibeAppServerError>;
    readonly eventsRead: (input: {
      afterEventId?: number | null | undefined;
      sessionIds?: ReadonlyArray<string>;
      batchSize?: number;
    }) => Effect.Effect<ReadonlyArray<unknown>, VibeError.VibeAppServerError>;
    readonly workspaceTrustStatus: (
      cwd: string,
    ) => Effect.Effect<TrustStatusResult, VibeError.VibeAppServerError>;
    readonly workspaceTrustDecision: (input: {
      decision: string;
      cwd?: string | null | undefined;
      sessionId?: string | null | undefined;
    }) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly workspaceGitCheckouts: (input: {
      repoLocalPaths: ReadonlyArray<string>;
      sessionCwd?: string | null | undefined;
    }) => Effect.Effect<ReadonlyArray<GitCheckout>, VibeError.VibeAppServerError>;
    readonly setupStatus: (
      sessionId?: string,
    ) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly providerAuthRead: (
      sessionId: string,
    ) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
    readonly callbackResult: (input: {
      sessionId: string;
      callbackId: string;
      result: unknown;
    }) => Effect.Effect<unknown, VibeError.VibeAppServerError>;
  }
>()("@t3tools/vibe-app-server/client/VibeAppServerClient") {}

const decodeTurnItem = Schema.decodeUnknownEffect(PublicTurn as Schema.Codec<PublicTurn, unknown>);

const decode =
  <A>(schema: Schema.Schema<A>, method: string) =>
  (raw: unknown): Effect.Effect<A, VibeError.VibeAppServerError> =>
    Schema.decodeUnknownEffect(schema as Schema.Codec<A, unknown>)(raw).pipe(
      Effect.mapError(
        (error) =>
          new VibeError.VibeAppServerProtocolError({
            detail: `${method} response failed to decode: ${error.message}`,
            cause: error,
          }),
      ),
    );

export const make = Effect.fn("@t3tools/vibe-app-server/VibeAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: VibeAppServerClientOptions = {},
  terminationError?: Effect.Effect<VibeError.VibeAppServerError>,
): Effect.fn.Return<VibeAppServerClient["Service"], never, Scope.Scope> {
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();
  let unknownRequestHandler: ServerRequestHandler | undefined;
  let unknownNotificationHandler: ServerNotificationHandler | undefined;

  const protocol = yield* VibeProtocol.makeVibeAppServerProtocol({
    stdio,
    ...(terminationError === undefined ? {} : { terminationError }),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    onRequest: (request) => {
      if (requestHandlers.has(request.method)) {
        return requestHandlers.get(request.method)!(request.method, request.params ?? {});
      }
      return unknownRequestHandler !== undefined
        ? unknownRequestHandler(request.method, request.params ?? {})
        : Effect.fail(
            new VibeError.VibeAppServerRequestError({
              method: request.method,
              code: "method_not_found",
              detail: `Method not found: ${request.method}`,
            }),
          );
    },
    onNotification: (notification) => {
      const handlers = notificationHandlers.get(notification.method) ?? [];
      const unknown = unknownNotificationHandler;
      return Effect.forEach(
        [...handlers, ...(unknown === undefined ? [] : [unknown])],
        (handler) => handler(notification.method, notification.params ?? {}),
        { discard: true },
      ).pipe(Effect.asVoid);
    },
  });

  const requestRaw = protocol.request;

  const typed = <A>(
    method: string,
    schema: Schema.Schema<A>,
    params?: unknown,
  ): Effect.Effect<A, VibeError.VibeAppServerError> =>
    Effect.flatMap(requestRaw(method, params), decode(schema, method));

  return VibeAppServerClient.of({
    awaitTermination: protocol.awaitTermination,
    request: requestRaw,
    notify: protocol.notify,
    handleServerRequest: Effect.fn("VibeAppServerClient.handleServerRequest")(
      function (method, handler) {
        return Effect.sync(() => {
          requestHandlers.set(method, handler);
        });
      },
    ),
    handleServerNotification: Effect.fn("VibeAppServerClient.handleServerNotification")(
      function (method, handler) {
        return Effect.sync(() => {
          const current = notificationHandlers.get(method) ?? [];
          current.push(handler);
          notificationHandlers.set(method, current);
        });
      },
    ),
    handleUnknownServerRequest: Effect.fn("VibeAppServerClient.handleUnknownServerRequest")(
      function (handler) {
        return Effect.sync(() => {
          unknownRequestHandler = handler;
        });
      },
    ),
    handleUnknownServerNotification: Effect.fn(
      "VibeAppServerClient.handleUnknownServerNotification",
    )(function (handler) {
      return Effect.sync(() => {
        unknownNotificationHandler = handler;
      });
    }),

    initialize: Effect.fn("VibeAppServerClient.initialize")(function* (input) {
      return yield* typed("initialize", InitializeResult, {
        clientInfo: { name: input.clientName, version: input.clientVersion },
        ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      });
    }),
    initialized: Effect.fn("VibeAppServerClient.initialized")(function* () {
      return yield* protocol.notify("initialized", {});
    }),
    accountRead: Effect.fn("VibeAppServerClient.accountRead")(function* (sessionId) {
      const result = yield* typed("account/read", AccountReadResult, { sessionId });
      return result.account;
    }),
    configRead: Effect.fn("VibeAppServerClient.configRead")(function* (sessionId) {
      const result = yield* typed(
        "config/read",
        ConfigReadResult,
        sessionId === undefined ? {} : { sessionId },
      );
      return result.config;
    }),
    configModelWrite: Effect.fn("VibeAppServerClient.configModelWrite")(function* (input) {
      return yield* requestRaw("config/model/write", {
        sessionId: input.sessionId,
        ...(input.modelAlias !== undefined ? { modelAlias: input.modelAlias } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.sessionOnly !== undefined ? { sessionOnly: input.sessionOnly } : {}),
      });
    }),
    sessionStart: Effect.fn("VibeAppServerClient.sessionStart")(function* (params) {
      return yield* typed("session/start", SessionStartResult, params);
    }),
    sessionResume: Effect.fn("VibeAppServerClient.sessionResume")(function* (input) {
      return yield* typed("session/resume", SessionResumeResult, {
        sessionId: input.sessionId,
        ...(input.agentConfig !== undefined ? { agentConfig: input.agentConfig } : {}),
      });
    }),
    sessionRead: Effect.fn("VibeAppServerClient.sessionRead")(function* (input) {
      return yield* typed("session/read", SessionStartResult, {
        sessionId: input.sessionId,
        ...(input.history !== undefined ? { history: input.history } : {}),
        ...(input.turns !== undefined ? { turns: input.turns } : {}),
      });
    }),
    sessionList: Effect.fn("VibeAppServerClient.sessionList")(function* (params) {
      return yield* typed("session/list", PageResult, params ?? {});
    }),
    sessionDelete: Effect.fn("VibeAppServerClient.sessionDelete")(function* (sessionId) {
      return yield* requestRaw("session/delete", { sessionId });
    }),
    sessionStop: Effect.fn("VibeAppServerClient.sessionStop")(function* (input) {
      return yield* requestRaw("session/stop", {
        sessionId: input.sessionId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    }),
    sessionTurnEnqueue: Effect.fn("VibeAppServerClient.sessionTurnEnqueue")(function* (input) {
      return yield* typed("session/turn/enqueue", TurnEnqueueResult, {
        sessionId: input.sessionId,
        entries: input.entries,
      });
    }),
    turnSteer: Effect.fn("VibeAppServerClient.turnSteer")(function* (input) {
      return yield* requestRaw("turn/steer", {
        sessionId: input.sessionId,
        expectedTurnId: input.expectedTurnId,
        message: input.message,
      });
    }),
    turnInterrupt: Effect.fn("VibeAppServerClient.turnInterrupt")(function* (input) {
      return yield* requestRaw("turn/interrupt", {
        sessionId: input.sessionId,
        expectedTurnId: input.expectedTurnId,
      });
    }),
    sessionHistoryList: Effect.fn("VibeAppServerClient.sessionHistoryList")(function* (input) {
      const page: Record<string, unknown> = { limit: input.limit ?? 200 };
      if (input.cursor !== undefined && input.cursor !== null) page["cursor"] = input.cursor;
      return yield* typed("session/history/list", PageResult, {
        sessionId: input.sessionId,
        page,
      });
    }),
    sessionTurnsList: Effect.fn("VibeAppServerClient.sessionTurnsList")(function* (input) {
      const page: Record<string, unknown> = { limit: input.limit ?? 200 };
      if (input.cursor !== undefined && input.cursor !== null) page["cursor"] = input.cursor;
      const pageResult = yield* typed("session/turns/list", PageResult, {
        sessionId: input.sessionId,
        page,
      });
      return yield* Effect.forEach(pageResult.items, (item) =>
        decodeTurnItem(item).pipe(
          Effect.mapError(
            (error) =>
              new VibeError.VibeAppServerProtocolError({
                detail: `session/turns/list item failed to decode: ${error.message}`,
                cause: error,
              }),
          ),
        ),
      );
    }),
    eventsRead: Effect.fn("VibeAppServerClient.eventsRead")(function* (input) {
      const filters: Record<string, unknown> = {};
      if (input.sessionIds !== undefined) filters["sessionIds"] = [...input.sessionIds];
      const params: Record<string, unknown> = { filters };
      if (input.afterEventId !== undefined && input.afterEventId !== null) {
        params["afterEventId"] = input.afterEventId;
      }
      if (input.batchSize !== undefined) params["batchSize"] = input.batchSize;
      const result = yield* typed("events/read", EventsReadResult, params);
      return result.events;
    }),
    workspaceTrustStatus: Effect.fn("VibeAppServerClient.workspaceTrustStatus")(function* (cwd) {
      return yield* typed("workspace/trust/status", TrustStatusResult, { cwd });
    }),
    workspaceTrustDecision: Effect.fn("VibeAppServerClient.workspaceTrustDecision")(
      function* (input) {
        return yield* requestRaw("workspace/trust/decision", {
          decision: input.decision,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
      },
    ),
    workspaceGitCheckouts: Effect.fn("VibeAppServerClient.workspaceGitCheckouts")(
      function* (input) {
        const result = yield* typed("workspace/git/checkouts", GitCheckoutsResult, {
          repoLocalPaths: [...input.repoLocalPaths],
          ...(input.sessionCwd !== undefined ? { sessionCwd: input.sessionCwd } : {}),
        });
        return result.checkouts ?? [];
      },
    ),
    setupStatus: Effect.fn("VibeAppServerClient.setupStatus")(function* (sessionId) {
      return yield* requestRaw("setup/status", sessionId === undefined ? {} : { sessionId });
    }),
    providerAuthRead: Effect.fn("VibeAppServerClient.providerAuthRead")(function* (sessionId) {
      return yield* requestRaw("providerAuth/read", { sessionId });
    }),
    callbackResult: Effect.fn("VibeAppServerClient.callbackResult")(function* (input) {
      return yield* requestRaw("callback/result", {
        sessionId: input.sessionId,
        result: {
          callbackId: input.callbackId,
          output: input.result,
        },
      });
    }),
  });
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: VibeAppServerClientOptions = {},
): Layer.Layer<VibeAppServerClient> =>
  Layer.effect(VibeAppServerClient, makeChildProcessClient(handle, options));

const makeChildProcessClient = Effect.fn(
  "@t3tools/vibe-app-server/VibeAppServerClient.makeChildProcessClient",
)(function* (handle: ChildProcessSpawner.ChildProcessHandle, options: VibeAppServerClientOptions) {
  const encoder = new TextEncoder();
  // Drain the child's stderr in a scoped fiber, or a chatty server can block on a full pipe.
  yield* Effect.forkScoped(handle.stderr.pipe(Stream.runDrain));
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });
  const terminationError = handle.exitCode.pipe(
    Effect.map(
      (code): VibeError.VibeAppServerError =>
        new VibeError.VibeAppServerTerminatedError({ exitCode: Number(code) }),
    ),
    Effect.catchCause((cause): Effect.Effect<VibeError.VibeAppServerError> =>
      Effect.succeed(new VibeError.VibeAppServerTerminatedError({ exitCode: null, cause })),
    ),
  );
  return yield* make(stdio, options, terminationError);
});

/** In-memory stdio pair for tests: feed server output via `input`, read client writes via `output`. */
export const makeInMemoryStdio = Effect.fn("@t3tools/vibe-app-server/makeInMemoryStdio")(
  function* () {
    const input = yield* Queue.unbounded<Uint8Array>();
    const output = yield* Queue.unbounded<string>();
    const decoder = new TextDecoder();
    const stdio = Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    });
    return { stdio, input, output };
  },
);
